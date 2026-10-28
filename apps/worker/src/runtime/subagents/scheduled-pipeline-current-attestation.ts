import {
  buildScheduledAutomationPipelineCurrentAttestation, createScheduledAutomationPipelineBridge,
  type ScheduledAutomationPipelineBridgeResult,
  type ScheduledAutomationPipelineBridgeScope,
  type ScheduledAutomationPipelineBridgeState,
  type ScheduledAutomationPipelineBridgeDependencies,
  type ScheduledAutomationPersistedTask,
} from "./scheduled-automation-pipeline-bridge.js"
import { parseTaskGraphSnapshot, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import type { TaskGraphCurrentState } from "./task-graph-command-port.js"
import type { GraphTaskRow } from "./task-graph-pg-state.js"
import { projectScheduledPipelineGraph } from "./scheduled-pipeline-graph-shape.js"
import { parseScheduledTaskGraphContinuationReceipt, scheduledTaskGraphContinuationKeyVersion,
  scheduledTaskGraphStableContinuationKey, type ScheduledTaskGraphContinuationReceipt } from "./scheduled-taskgraph-continuation-receipt.js"

/** Rebuilds source/Analyst evidence from caller-loaded rows without applying active-Root admission. */
export function buildScheduledPipelineGraphAttestation(input: Readonly<{
  scope: ScheduledAutomationPipelineBridgeScope
  schedule: unknown
  snapshot: unknown
  current: TaskGraphCurrentState
  tasks: ReadonlyMap<string, GraphTaskRow>
  verifyCompletedNode: ScheduledAutomationPipelineBridgeDependencies["verifyCompletedNode"]
}>): Promise<ScheduledAutomationPipelineBridgeResult> {
  let snapshot: TaskGraphSnapshot
  try { snapshot = parseTaskGraphSnapshot(input.snapshot) } catch {
    return Promise.resolve({ status: "blocked", reasonCode: "scheduled_snapshot_invalid" })
  }
  const tasks: ScheduledAutomationPersistedTask[] = []
  for (const node of snapshot.nodes) {
    const task = input.tasks.get(node.taskId)
    if (!task) return Promise.resolve({ status: "blocked", reasonCode: "task_graph_incomplete" })
    tasks.push({ id: task.id, userId: input.scope.userId, sessionId: input.scope.sessionId,
      turnId: input.scope.turnId, rootTaskId: input.scope.rootTaskId, parentTaskId: input.scope.rootTaskId,
      role: task.role, taskType: task.taskType ?? "", status: task.status, attemptCount: task.attemptCount ?? 0,
      failureReason: task.failureReason, expectedOutputSchema: task.expectedOutputSchema,
      allowedActions: task.allowedActions, result: task.result })
  }
  return buildScheduledAutomationPipelineCurrentAttestation({ scope: input.scope, schedule: input.schedule,
    snapshot, current: input.current, tasks, dependencies: { verifyCompletedNode: input.verifyCompletedNode } })
}

/** Rebuilds Analyze proof from the receipt's immutable graph revision during Prepare, excluding its appended suffix. */
export function revalidateScheduledPipelineGraphAttestation(input: Readonly<{
  scope: ScheduledAutomationPipelineBridgeScope
  schedule: unknown
  snapshot: unknown
  current: TaskGraphCurrentState
  tasks: ReadonlyMap<string, GraphTaskRow>
  receipt: unknown
  verifyCompletedNode: ScheduledAutomationPipelineBridgeDependencies["verifyCompletedNode"]
}>): Promise<ScheduledAutomationPipelineBridgeResult> {
  const receipt = parseScheduledTaskGraphContinuationReceipt(input.receipt)
  const version = receipt && scheduledTaskGraphContinuationKeyVersion(receipt.continuationKey)
  let snapshot: TaskGraphSnapshot
  try { snapshot = parseTaskGraphSnapshot(input.snapshot) } catch {
    return Promise.resolve({ status: "blocked", reasonCode: "scheduled_snapshot_invalid" })
  }
  const prefix = version && projectScheduledPipelineGraph(snapshot.nodes, version, "prepare")
  if (!receipt || !version || scheduledTaskGraphStableContinuationKey(receipt) !== receipt.continuationKey
    || !scheduledPrepareReceiptOwnerMatches(receipt, input.scope)
    || !prefix || !Number.isSafeInteger(input.current.revision) || input.current.nodes.length !== snapshot.nodes.length) {
    return Promise.resolve({ status: "blocked", reasonCode: "task_graph_node_invalid" })
  }
  const count = prefix.scouts.length + 1, nodes = snapshot.nodes.slice(0, count), currentNodes = input.current.nodes.slice(0, count)
  if (nodes.some((node, index) => currentNodes[index]?.key !== node.key || currentNodes[index]?.taskId !== node.taskId)) {
    return Promise.resolve({ status: "blocked", reasonCode: "task_graph_node_invalid" })
  }
  const tasks = new Map(nodes.flatMap(node => {
    const task = input.tasks.get(node.taskId)
    return task ? [[node.taskId, task] as const] : []
  }))
  if (tasks.size !== count) return Promise.resolve({ status: "blocked", reasonCode: "task_graph_incomplete" })
  const analyzeSnapshot = { schemaVersion: snapshot.schemaVersion, nodes,
    ...(snapshot.rootSuccessCriteria ? { rootSuccessCriteria: snapshot.rootSuccessCriteria } : {}) }
  const analyzeCurrent = { revision: receipt.analyzeGraphRevision, nodes: currentNodes,
    ...(input.current.rootSuccessCriteria ? { rootSuccessCriteria: input.current.rootSuccessCriteria } : {}) }
  return buildScheduledPipelineGraphAttestation({ scope: input.scope, schedule: input.schedule,
    snapshot: analyzeSnapshot, current: analyzeCurrent, tasks, verifyCompletedNode: input.verifyCompletedNode })
}

/** Stable receipt lineage survives a Turn lease renewal; the caller proves the live lease independently. */
export function scheduledPrepareReceiptOwnerMatches(
  receipt: ScheduledTaskGraphContinuationReceipt, scope: ScheduledAutomationPipelineBridgeScope,
): boolean {
  return receipt.owner.userId === scope.userId && receipt.owner.sessionId === scope.sessionId
    && receipt.owner.turnId === scope.turnId && receipt.owner.rootTaskId === scope.rootTaskId
    && receipt.owner.rootAttemptCount === scope.rootAttemptCount
}

/** Revalidates a same-transaction persisted view through the canonical evidence builder. */
export function revalidateScheduledPipelineCurrentAttestation(input: Readonly<{
  scope: ScheduledAutomationPipelineBridgeScope
  state: ScheduledAutomationPipelineBridgeState
  verifyCompletedNode: ScheduledAutomationPipelineBridgeDependencies["verifyCompletedNode"]
}>): Promise<ScheduledAutomationPipelineBridgeResult> {
  return createScheduledAutomationPipelineBridge({
    load: async () => input.state,
    verifyCompletedNode: input.verifyCompletedNode,
  })(input.scope)
}
