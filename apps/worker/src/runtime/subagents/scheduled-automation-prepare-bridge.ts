import { createHash } from "node:crypto"
import type { DurableWaitPort } from "../tools/coordination-types.js"
import type { TaskGraphCommandPort, TaskGraphCurrentState, TaskGraphExecutionScope, TaskGraphReadScope, TaskGraphScheduledPrepareInput } from "./task-graph-command-port.js"
import type { ScheduledPipelinePrepareContinuation } from "./scheduled-pipeline-completion.js"
import { canonicalTaskGraphJson, parseTaskGraphSnapshot, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import { buildScheduledPrepareTaskGraphProof, type ScheduledPrepareTaskGraphProof, type ScheduledPrepareVerification } from "./scheduled-prepare-task-graph-verification.js"

const WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1_000
const PREPARE_GOAL = "Prepare application materials using the persisted scheduled Analyze checkpoint."
const PREPARE_CRITERIA = [
  "Prepare only jobs and 0-100 scores from the verified scheduled Analyze checkpoint.",
  "Persist immutable owner-fenced material references and return no resume or letter bodies.",
]

type PipelineTask = Readonly<{ id: string; role: string; taskType: string; status: string; attemptCount: number; failureReason: string | null; expectedOutputSchema: unknown; allowedActions: unknown }>
export type ScheduledAnalyzePrefix<T extends PipelineTask = PipelineTask> = Readonly<{ snapshot: TaskGraphSnapshot; current: TaskGraphCurrentState; tasks: readonly T[] }>
export type ScheduledPipelinePrepareResult = Readonly<{ status: "waiting_for_dependency"; waitId: string }>
  | Readonly<{ status: "waiting_for_choice"; waitId: string }>
  | Readonly<{ status: "ready"; prepareProof: ScheduledPrepareTaskGraphProof;
    choice: Readonly<{ required: true; status: "answered"; scheduledWaitId: string }> | Readonly<{ required: false }> }>
type ReadyPrepareVerifier = (input: Readonly<{ scope: TaskGraphExecutionScope; prepareTaskId: string; signal: AbortSignal }>) => Promise<ScheduledPrepareVerification>

/** Projects the stable Scout+Analyst revision from an exact initial graph or one appended Prepare node. */
export function projectScheduledAnalyzePrefix<T extends PipelineTask>(snapshotValue: unknown, current: TaskGraphCurrentState, tasks: readonly T[]): ScheduledAnalyzePrefix<T> | null {
  let snapshot: TaskGraphSnapshot
  try { snapshot = parseTaskGraphSnapshot(snapshotValue) } catch { return null }
  const count = snapshot.nodes.length
  if ((count !== 2 && count !== 3) || current.nodes.length !== count || tasks.length !== count
    || !Number.isSafeInteger(current.revision) || current.revision < count) return null
  const [scout, analyst, prepare] = snapshot.nodes
  if (scout?.templateId !== "scout" || scout.depth !== 1 || scout.dependsOn.length !== 0
    || analyst?.templateId !== "analyst" || analyst.depth !== 2 || analyst.dependsOn.length !== 1 || analyst.dependsOn[0] !== scout.key) return null
  if (prepare) {
    const currentPrepare = current.nodes.find(node => node.key === prepare.key), task = tasks.find(value => value.id === prepare.taskId)
    if (prepare.key !== "prepare" || prepare.templateId !== "prepare" || prepare.depth !== 3 || prepare.dependsOn.length !== 1
      || prepare.dependsOn[0] !== analyst.key || prepare.verificationDisposition !== "specialized" || prepare.verification !== undefined
      || prepare.goal !== PREPARE_GOAL || prepare.successCriteria.length !== PREPARE_CRITERIA.length
      || !prepare.successCriteria.every((value, index) => value === PREPARE_CRITERIA[index])
      || !currentPrepare || currentPrepare.taskId !== prepare.taskId || currentPrepare.templateId !== "prepare"
      || currentPrepare.status !== task?.status || currentPrepare.failureReason !== task?.failureReason
      || !task || task.role !== TASK_GRAPH_TEMPLATES.prepare.role || task.taskType !== TASK_GRAPH_TEMPLATES.prepare.taskType
      || task.status !== "queued" || task.attemptCount !== 0 || task.failureReason !== null
      || !sameJson(task.expectedOutputSchema, TASK_GRAPH_TEMPLATES.prepare.expectedOutputSchema)
      || !sameJson(task.allowedActions, TASK_GRAPH_TEMPLATES.prepare.allowedActions)) return null
  }
  const prefix = parseTaskGraphSnapshot({ schemaVersion: snapshot.schemaVersion, nodes: snapshot.nodes.slice(0, 2),
    ...(snapshot.rootSuccessCriteria ? { rootSuccessCriteria: snapshot.rootSuccessCriteria } : {}) })
  return { snapshot: prefix, current: { revision: count === 3 ? current.revision - 1 : current.revision,
    nodes: current.nodes.slice(0, 2), ...(current.rootSuccessCriteria ? { rootSuccessCriteria: current.rootSuccessCriteria } : {}) }, tasks: tasks.slice(0, 2) }
}

/** Appends the fixed Prepare node and waits on its durable same-root TaskGraph task. */
export function createScheduledAutomationPrepareContinuation(input: Readonly<{
  commandPort: TaskGraphCommandPort
  waitPort: DurableWaitPort
  verifyReadyPrepare?: ReadyPrepareVerifier
}>): (continuation: Parameters<ScheduledPipelinePrepareContinuation>[0]) => Promise<ScheduledPipelinePrepareResult> {
  return async continuation => {
    const executionOwner = continuation.executionOwner
    if (executionOwner.kind !== "turn" || executionOwner.userId !== continuation.owner.userId
      || executionOwner.sessionId !== continuation.owner.sessionId || executionOwner.turnId !== continuation.owner.turnId
      || executionOwner.rootTaskId !== continuation.owner.rootTaskId || executionOwner.taskId !== continuation.owner.rootTaskId
      || executionOwner.ownerId !== continuation.owner.turnLeaseOwnerId || executionOwner.leaseVersion !== continuation.owner.turnLeaseVersion
      || continuation.proof.continuationKey.trim().length === 0
      || continuation.proof.executionAttemptCount < 0) throw new Error("scheduled_prepare_owner_invalid")
    const readScope: TaskGraphReadScope = {
      userId: continuation.owner.userId, sessionId: continuation.owner.sessionId, turnId: continuation.owner.turnId,
      rootTaskId: continuation.owner.rootTaskId, parentTaskId: continuation.owner.rootTaskId,
      turnLeaseOwner: continuation.owner.turnLeaseOwnerId,
      turnLeaseVersion: continuation.owner.turnLeaseVersion, parentLeaseOwner: continuation.owner.turnLeaseOwnerId,
      parentAttemptCount: continuation.owner.rootAttemptCount,
    }
    const scope: TaskGraphExecutionScope = { ...readScope, stepId: continuation.finalStepId }
    const graph = await input.commandPort.readCurrent(readScope)
    const analyzeRevision = continuation.attestation.graphRevision
    if (!Number.isSafeInteger(analyzeRevision) || !Number.isSafeInteger(analyzeRevision + 1)
      || (graph.revision !== analyzeRevision && !hasScheduledPrepare(graph, analyzeRevision + 1))) {
      throw new Error("scheduled_prepare_analyze_revision_changed")
    }
    const analysts = graph.nodes.filter(node => node.templateId === "analyst" && node.taskId === continuation.attestation.analyst.taskId)
    if (analysts.length !== 1 || analysts[0]?.status !== "completed" || analysts[0].failureReason !== null) {
      throw new Error("scheduled_prepare_analyst_missing")
    }
    const proposal: TaskGraphScheduledPrepareInput["proposal"] = {
      // Keep the original Analyze revision. The command's private receipt is the authority for replay.
      expectedRevision: analyzeRevision,
      nodes: [{ key: "prepare", templateId: "prepare", goal: PREPARE_GOAL,
        successCriteria: PREPARE_CRITERIA, dependsOn: [analysts[0].key] }],
    }
    if (!input.commandPort.appendScheduledPrepare) throw new Error("scheduled_prepare_command_unavailable")
    const receipt = await input.commandPort.appendScheduledPrepare({
      scope, executionOwner: { executionId: continuation.proof.executionId,
        executionAttemptCount: continuation.proof.executionAttemptCount },
      handoff: continuation.proof, attestation: continuation.attestation, proposal,
    })
    const choice = receipt.choice
    if (receipt.status === "waiting_for_choice") {
      if (receipt.revision !== analyzeRevision || receipt.nodes.length !== 0 || receipt.readyTaskIds.length !== 0
        || !choice.required || choice.status !== "waiting" || !choice.waitId.trim() || choice.waitId.length > 256) {
        throw new Error("scheduled_prepare_choice_wait_invalid")
      }
      return { status: "waiting_for_choice", waitId: choice.waitId }
    }
    const nodes = receipt.nodes.filter(node => node.key === "prepare")
    if (nodes.length !== 1 || receipt.nodes.length !== 1 || !nodes[0]?.taskId.trim()
      || !["accepted", "duplicate"].includes(receipt.status)) throw new Error("scheduled_prepare_schedule_invalid")
    if (choice.required && (choice.waitId.trim() !== choice.waitId || !choice.waitId || choice.waitId.length > 256
      || choice.status !== "answered")) throw new Error("scheduled_prepare_choice_invalid")
    const wait = await input.waitPort.wait({ userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
      stepId: continuation.finalStepId, taskId: scope.rootTaskId, rootTaskId: scope.rootTaskId,
      targetTaskIds: [nodes[0].taskId], mode: "all", timeoutMs: WAIT_TIMEOUT_MS,
      idempotencyKey: waitKey(continuation.proof.continuationKey, continuation.finalStepId) })
    const prepareTaskId = nodes[0]!.taskId
    if (!wait.waitId.trim() || !["waiting", "ready"].includes(wait.status) || wait.matchedTaskIds.some(taskId => taskId !== prepareTaskId)
      || (wait.status === "ready" && (wait.matchedTaskIds.length !== 1 || wait.matchedTaskIds[0] !== prepareTaskId))) throw new Error("scheduled_prepare_wait_invalid")
    if (wait.status === "waiting") return { status: "waiting_for_dependency", waitId: wait.waitId }
    const verified = await input.verifyReadyPrepare?.({ scope, prepareTaskId, signal: continuation.signal })
    if (!verified?.verified) throw new Error("scheduled_prepare_completion_unverified")
    const prepareProof = buildScheduledPrepareTaskGraphProof(verified.facts, { waitId: wait.waitId, status: "ready", mode: "all",
      targetTaskIds: [prepareTaskId], matchedTaskIds: [prepareTaskId] })
    if (!prepareProof) throw new Error("scheduled_prepare_completion_unverified")
    return { status: "ready", prepareProof,
      choice: choice.required ? { required: true, status: "answered", scheduledWaitId: choice.waitId } : { required: false } }
  }
}

function hasScheduledPrepare(graph: Awaited<ReturnType<TaskGraphCommandPort["readCurrent"]>>, expectedRevision: number): boolean {
  const prepare = graph.nodes.filter(node => node.key === "prepare")
  const analyst = graph.nodes.filter(node => node.templateId === "analyst")
  return graph.revision >= expectedRevision && graph.nodes.length === 3 && prepare.length === 1 && analyst.length === 1
    && prepare[0]?.templateId === "prepare" && prepare[0].taskId.trim().length > 0
    && prepare[0].dependsOn.length === 1 && prepare[0].dependsOn[0] === analyst[0]?.key
    && prepare[0].goal === PREPARE_GOAL && prepare[0].successCriteria.length === PREPARE_CRITERIA.length
    && prepare[0].successCriteria.every((criterion, index) => criterion === PREPARE_CRITERIA[index])
    && prepare[0].failureReason === null
}

function waitKey(continuationKey: string, finalStepId: string): string {
  const digest = createHash("sha256").update(`${continuationKey}\0${finalStepId}`, "utf8").digest("hex")
  return `scheduled-prepare-dependency:${digest}`
}

function sameJson(left: unknown, right: unknown): boolean { try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false } }
