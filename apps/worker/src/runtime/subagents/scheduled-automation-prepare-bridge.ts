import { createHash } from "node:crypto"
import type { DurableWaitPort } from "../tools/coordination-types.js"
import type { TaskGraphCommandPort, TaskGraphCurrentState, TaskGraphExecutionScope, TaskGraphReadScope, TaskGraphScheduledPrepareInput } from "./task-graph-command-port.js"
import type { ScheduledPipelinePrepareContinuation } from "./scheduled-pipeline-completion.js"
import { canonicalTaskGraphJson } from "./task-graph-snapshot.js"
import { buildScheduledPrepareTaskGraphProof, type ScheduledPrepareTaskGraphProof, type ScheduledPrepareVerification } from "./scheduled-prepare-task-graph-verification.js"
import { projectScheduledPipelineGraph } from "./scheduled-pipeline-graph-shape.js"
export { projectScheduledAnalyzePrefix } from "./scheduled-analyze-prefix.js"
export type { ScheduledAnalyzePrefix } from "./scheduled-analyze-prefix.js"

const WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1_000
const PREPARE_GOAL = "Prepare application materials using the persisted scheduled Analyze checkpoint."
const PREPARE_CRITERIA = [
  "Prepare only jobs and 0-100 scores from the verified scheduled Analyze checkpoint.",
  "Persist immutable owner-fenced material references and return no resume or letter bodies.",
]

export type ScheduledPipelinePrepareResult = Readonly<{ status: "waiting_for_dependency"; waitId: string }>
  | Readonly<{ status: "waiting_for_choice"; waitId: string }>
  | Readonly<{ status: "ready"; prepareProof: ScheduledPrepareTaskGraphProof;
    choice: Readonly<{ required: true; status: "answered"; scheduledWaitId: string }> | Readonly<{ required: false }> }>
type ReadyPrepareVerifier = (input: Readonly<{ scope: TaskGraphExecutionScope; prepareTaskId: string; signal: AbortSignal }>) => Promise<ScheduledPrepareVerification>

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
    const scope: TaskGraphExecutionScope = { ...readScope, stepId: continuation.recoveryStepId }
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
      stepId: continuation.recoveryStepId, taskId: scope.rootTaskId, rootTaskId: scope.rootTaskId,
      targetTaskIds: [nodes[0].taskId], mode: "all", timeoutMs: WAIT_TIMEOUT_MS,
      idempotencyKey: waitKey(continuation.proof.continuationKey, continuation.recoveryStepId) })
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
  const scoutCount = graph.nodes.filter(node => node.templateId === "scout").length
  const stage = graph.nodes.length === scoutCount + 2 ? "prepare" : graph.nodes.length === scoutCount + 3 ? "gate"
    : graph.nodes.length === scoutCount + 4 ? "audit" : null
  const version = scoutCount === 1 ? "v1" : scoutCount >= 2 && scoutCount <= 4 ? "v2" : null
  if (!stage || !version || graph.revision < expectedRevision) return false
  const shapeNodes = graph.nodes.map((node, index) => ({ ...node,
    depth: index < scoutCount ? 1 : index === scoutCount ? 2 : index - scoutCount + 2,
  }))
  const projection = stage === "prepare" ? projectScheduledPipelineGraph(shapeNodes, version, "prepare")
    : stage === "gate" ? projectScheduledPipelineGraph(shapeNodes, version, "gate")
      : projectScheduledPipelineGraph(shapeNodes, version, "audit")
  const prepare = projection ? shapeNodes.find(node => node.key === "prepare") : undefined
  const gate = stage === "prepare" ? undefined : projection ? shapeNodes.find(node => node.key === "gate") : undefined
  return Boolean(projection && prepare && prepare.taskId.trim().length > 0
    && prepare.goal === PREPARE_GOAL && sameJson(prepare.successCriteria, PREPARE_CRITERIA)
    && prepare.failureReason === null && prepare.status === "completed"
    && (!gate || gate.status !== "failed" && gate.status !== "cancelled" && gate.failureReason === null))
}

function waitKey(continuationKey: string, recoveryStepId: string): string {
  const digest = createHash("sha256").update(`${continuationKey}\0${recoveryStepId}`, "utf8").digest("hex")
  return `scheduled-prepare-dependency:${digest}`
}

function sameJson(left: unknown, right: unknown): boolean { try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false } }
