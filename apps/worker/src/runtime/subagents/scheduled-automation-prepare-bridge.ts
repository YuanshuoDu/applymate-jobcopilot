import { createHash } from "node:crypto"
import type { DurableWaitPort } from "../tools/coordination-types.js"
import type { TaskGraphCommandPort, TaskGraphCurrentState, TaskGraphExecutionScope, TaskGraphReadScope, TaskGraphScheduledPrepareInput } from "./task-graph-command-port.js"
import type { ScheduledPipelinePrepareContinuation } from "./scheduled-pipeline-completion.js"
import { canonicalTaskGraphJson, parseTaskGraphSnapshot, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import { buildScheduledPrepareTaskGraphProof, SCHEDULED_PREPARE_COMPLETION_SCHEMA, SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA,
  scheduledPrepareResultDigest, type ScheduledPrepareTaskGraphProof, type ScheduledPrepareVerification } from "./scheduled-prepare-task-graph-verification.js"
import { parseScheduledTaskGraphContinuationReceipt, scheduledTaskGraphStableContinuationKey } from "./scheduled-taskgraph-continuation-receipt.js"
import { validateRoleResult } from "./role-results.js"
import { SCHEDULED_GATE_NODE_CRITERIA, SCHEDULED_GATE_NODE_GOAL, SCHEDULED_GATE_OUTPUT_SCHEMA,
  SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE, SCHEDULED_GATE_TEMPLATE_ID } from "./scheduled-gate-contract.js"

const WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1_000
const PREPARE_GOAL = "Prepare application materials using the persisted scheduled Analyze checkpoint."
const PREPARE_CRITERIA = [
  "Prepare only jobs and 0-100 scores from the verified scheduled Analyze checkpoint.",
  "Persist immutable owner-fenced material references and return no resume or letter bodies.",
]

type PipelineTask = Readonly<{ id: string; role: string; taskType: string; status: string; attemptCount: number; failureReason: string | null;
  expectedOutputSchema: unknown; allowedActions: unknown; result?: unknown; rootTaskId?: string; parentTaskId?: string }>
export type ScheduledAnalyzePrefix<T extends PipelineTask = PipelineTask> = Readonly<{ snapshot: TaskGraphSnapshot; current: TaskGraphCurrentState; tasks: readonly T[] }>
export type ScheduledPipelinePrepareResult = Readonly<{ status: "waiting_for_dependency"; waitId: string }>
  | Readonly<{ status: "waiting_for_choice"; waitId: string }>
  | Readonly<{ status: "ready"; prepareProof: ScheduledPrepareTaskGraphProof;
    choice: Readonly<{ required: true; status: "answered"; scheduledWaitId: string }> | Readonly<{ required: false }> }>
type ReadyPrepareVerifier = (input: Readonly<{ scope: TaskGraphExecutionScope; prepareTaskId: string; signal: AbortSignal }>) => Promise<ScheduledPrepareVerification>

/** Projects the immutable Scout+Analyst revision from its exact Prepare proof after later Gate appends. */
export function projectScheduledAnalyzePrefix<T extends PipelineTask>(snapshotValue: unknown, current: TaskGraphCurrentState, tasks: readonly T[]): ScheduledAnalyzePrefix<T> | null {
  let snapshot: TaskGraphSnapshot
  try { snapshot = parseTaskGraphSnapshot(snapshotValue) } catch { return null }
  const count = snapshot.nodes.length
  if ((count !== 2 && count !== 3 && count !== 4) || current.nodes.length !== count || tasks.length !== count
    || !Number.isSafeInteger(current.revision) || current.revision < count) return null
  const [scout, analyst, prepare] = snapshot.nodes
  if (scout?.templateId !== "scout" || scout.depth !== 1 || scout.dependsOn.length !== 0
    || analyst?.templateId !== "analyst" || analyst.depth !== 2 || analyst.dependsOn.length !== 1 || analyst.dependsOn[0] !== scout.key) return null
  const scoutTask = prefixTask(scout, tasks, TASK_GRAPH_TEMPLATES.scout.role, TASK_GRAPH_TEMPLATES.scout.taskType)
  const analystTask = prefixTask(analyst, tasks, TASK_GRAPH_TEMPLATES.analyst.role, TASK_GRAPH_TEMPLATES.analyst.taskType)
  if (!scoutTask || !analystTask) return null
  let analyzeRevision = current.revision
  if (prepare) {
    const currentPrepare = current.nodes.find(node => node.key === prepare.key), task = tasks.find(value => value.id === prepare.taskId)
    if (prepare.key !== "prepare" || prepare.templateId !== "prepare" || prepare.depth !== 3 || prepare.dependsOn.length !== 1
      || prepare.dependsOn[0] !== analyst.key || prepare.verificationDisposition !== "specialized" || prepare.verification !== undefined
      || prepare.goal !== PREPARE_GOAL || prepare.successCriteria.length !== PREPARE_CRITERIA.length
      || !prepare.successCriteria.every((value, index) => value === PREPARE_CRITERIA[index])
      || !currentPrepare || currentPrepare.taskId !== prepare.taskId || currentPrepare.templateId !== "prepare"
      || currentPrepare.status !== task?.status || currentPrepare.failureReason !== task?.failureReason
      || !task || task.role !== TASK_GRAPH_TEMPLATES.prepare.role || task.taskType !== TASK_GRAPH_TEMPLATES.prepare.taskType
      || task.status !== "completed" || !Number.isSafeInteger(task.attemptCount) || task.attemptCount < 1 || task.failureReason !== null
      || !sameJson(task.expectedOutputSchema, TASK_GRAPH_TEMPLATES.prepare.expectedOutputSchema)
      || !sameJson(task.allowedActions, TASK_GRAPH_TEMPLATES.prepare.allowedActions)) return null
    const prepared = prepareAnalyzeRevision(task, prepare, snapshot, current.revision)
    if (prepared === null) return null
    analyzeRevision = prepared
    if (count === 4 && !validGateSuffix(snapshot.nodes[3], current, tasks, task)) return null
  }
  if (count === 2 && (snapshot.nodes.length !== 2 || current.nodes.length !== 2)) return null
  const prefix = parseTaskGraphSnapshot({ schemaVersion: snapshot.schemaVersion, nodes: snapshot.nodes.slice(0, 2),
    ...(snapshot.rootSuccessCriteria ? { rootSuccessCriteria: snapshot.rootSuccessCriteria } : {}) })
  return { snapshot: prefix, current: { revision: analyzeRevision,
    nodes: current.nodes.slice(0, 2), ...(current.rootSuccessCriteria ? { rootSuccessCriteria: current.rootSuccessCriteria } : {}) }, tasks: [scoutTask, analystTask] }
}

function prefixTask<T extends PipelineTask>(node: TaskGraphSnapshot["nodes"][number], tasks: readonly T[], role: string, taskType: string): T | null {
  const matches = tasks.filter(task => task.id === node.taskId), task = matches[0]
  return matches.length === 1 && task?.role === role && task.taskType === taskType ? task : null
}

function prepareAnalyzeRevision<T extends PipelineTask>(task: T, node: TaskGraphSnapshot["nodes"][number], snapshot: TaskGraphSnapshot, currentRevision: number): number | null {
  const envelope = record(task.result), facts = record(envelope?.taskGraphScheduledPrepareProofFacts)
  const receipt = parseScheduledTaskGraphContinuationReceipt(facts?.receipt), completion = record(facts?.completion)
  if (!envelope || envelope.status !== "completed" || !sameJson(envelope.structuredResult, facts?.result)
    || !facts || !exact(facts, ["schemaVersion", "receipt", "completion", "result"])
    || facts.schemaVersion !== SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA || !receipt
    || receipt.continuationKey !== scheduledTaskGraphStableContinuationKey(receipt)
    || receipt.prepareScheduleRevision !== receipt.analyzeGraphRevision + 1
    || receipt.prepareScheduleRevision > currentRevision || !completion
    || !exact(completion, ["schemaVersion", "graphRevision", "nodes"])
    || completion.schemaVersion !== SCHEDULED_PREPARE_COMPLETION_SCHEMA || !positive(completion.graphRevision)
    || completion.graphRevision <= receipt.prepareScheduleRevision || completion.graphRevision > currentRevision
    || !Array.isArray(completion.nodes) || completion.nodes.length !== 3
    || receipt.owner.rootTaskId !== task.parentTaskId || task.rootTaskId !== task.parentTaskId) return null
  let result: ReturnType<typeof validatePrepareResult>
  try { result = validatePrepareResult(facts.result) } catch { return null }
  if (result.status !== "completed" || result.taskId !== task.id || result.attemptCount !== task.attemptCount
    || result.snapshotDigest !== receipt.snapshotDigest || result.checkpointDigest !== receipt.checkpointDigest
    || scheduledPrepareResultDigest(result) !== (completion.nodes[2] as Record<string, unknown> | undefined)?.resultDigest) return null
  for (let index = 0; index < 3; index += 1) {
    const graphNode = snapshot.nodes[index], certified = record(completion.nodes[index])
    if (!graphNode || !certified || graphNode.taskId !== certified.taskId || graphNode.templateId !== certified.role
      || certified.status !== "completed" || certified.verification !== "passed"
      || Number(certified.attemptCount) < 1 || !Array.isArray(certified.dependsOnTaskIds)
      || !sameJson(certified.dependsOnTaskIds, index === 0 ? [] : [snapshot.nodes[index - 1]?.taskId])) return null
  }
  return receipt.analyzeGraphRevision
}

function validatePrepareResult(value: unknown) { return validateRoleResult(value, "prepare") }

function validGateSuffix<T extends PipelineTask>(node: TaskGraphSnapshot["nodes"][number] | undefined, current: TaskGraphCurrentState,
  tasks: readonly T[], prepare: T): boolean {
  const gate = node, state = gate && current.nodes.find(value => value.key === gate.key), task = gate && tasks.find(value => value.id === gate.taskId)
  return Boolean(gate && gate.key === SCHEDULED_GATE_TEMPLATE_ID && gate.templateId === SCHEDULED_GATE_TEMPLATE_ID
    && gate.depth === 4 && gate.dependsOn.length === 1 && gate.dependsOn[0] === "prepare"
    && gate.verificationDisposition === "specialized" && gate.verification === undefined
    && gate.goal === SCHEDULED_GATE_NODE_GOAL && sameJson(gate.successCriteria, SCHEDULED_GATE_NODE_CRITERIA)
    && state && state.taskId === gate.taskId && state.templateId === SCHEDULED_GATE_TEMPLATE_ID && state.status === task?.status
    && state.failureReason === task?.failureReason && task && task.role === SCHEDULED_GATE_ROLE && task.taskType === SCHEDULED_GATE_TASK_TYPE
    && Number.isSafeInteger(task.attemptCount) && task.attemptCount >= 0 && !task.failureReason
    && ["queued", "running", "waiting_for_user", "completed"].includes(task.status)
    && (task.status === "queued" || task.attemptCount > 0)
    && sameJson(task.expectedOutputSchema, SCHEDULED_GATE_OUTPUT_SCHEMA) && sameJson(task.allowedActions, [])
    && task.rootTaskId === prepare.rootTaskId && task.parentTaskId === prepare.parentTaskId
    && task.rootTaskId === task.parentTaskId && !!task.rootTaskId)
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value)
  return actual.length === keys.length && actual.every(key => typeof key === "string" && keys.includes(key))
}
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }

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
  const gate = graph.nodes.filter(node => node.key === SCHEDULED_GATE_TEMPLATE_ID)
  const base = graph.revision >= expectedRevision && (graph.nodes.length === 3 || graph.nodes.length === 4)
    && prepare.length === 1 && analyst.length === 1 && prepare[0]?.templateId === "prepare" && prepare[0].taskId.trim().length > 0
    && prepare[0].dependsOn.length === 1 && prepare[0].dependsOn[0] === analyst[0]?.key
    && prepare[0].goal === PREPARE_GOAL && sameJson(prepare[0].successCriteria, PREPARE_CRITERIA)
    && prepare[0].failureReason === null && prepare[0].status === "completed"
  if (!base) return false
  if (graph.nodes.length === 3) return gate.length === 0
  return gate.length === 1 && gate[0]?.templateId === SCHEDULED_GATE_TEMPLATE_ID
    && gate[0].status !== "failed" && gate[0].status !== "cancelled" && gate[0].failureReason === null
}

function waitKey(continuationKey: string, finalStepId: string): string {
  const digest = createHash("sha256").update(`${continuationKey}\0${finalStepId}`, "utf8").digest("hex")
  return `scheduled-prepare-dependency:${digest}`
}

function sameJson(left: unknown, right: unknown): boolean { try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false } }
