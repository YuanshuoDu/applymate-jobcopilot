import { projectPlanLedger, type PlanLedger, type PlanLedgerEvidencePreview, type PlanLedgerReadiness, type PlanLedgerStatus } from '@jobcopilot/agent-protocol'
import type { TimelineItem } from './timeline-reducer'
import type { SupervisorTaskSummary } from './task-tree-projection'
import { latestTaskGraphItem, type TaskGraphIdentity } from './task-graph-plan-query'
import { parseTaskGraphSnapshot } from './task-graph-plan-snapshot'

export { parseTaskGraphSnapshot } from './task-graph-plan-snapshot'
export type TaskGraphPlanStatus = PlanLedgerStatus
export type TaskGraphPlanReadiness = PlanLedgerReadiness
export type TaskGraphEvidencePreview = PlanLedgerEvidencePreview
export type TaskGraphPlanNode = PlanLedger['nodes'][number]
export type TaskGraphPlan = PlanLedger

/** Projects criteria only when the matched ledger node keys still mirror its exact source snapshot. */
export function projectTaskGraphSuccessCriteria(
  items: readonly TimelineItem[], identity: TaskGraphIdentity | null, plan: TaskGraphPlan | null,
): ReadonlyMap<string, readonly string[]> | null {
  if (!identity || !plan || identity.sessionId !== plan.sessionId || identity.revision !== plan.revision) return null
  const matches = items.filter(item => item.id === identity.graphItemId)
  const item = matches.length === 1 ? matches[0] : null
  if (!item || item.type !== 'task_graph' || item.sessionId !== identity.sessionId || item.turnId !== identity.turnId
    || item.taskId !== identity.rootTaskId || item.revision !== identity.revision) return null
  const snapshot = parseTaskGraphSnapshot(item.content)
  if (!snapshot || snapshot.nodes.length !== plan.nodes.length
    || snapshot.nodes.some((node, index) => node.key !== plan.nodes[index]?.key)) return null
  return new Map(snapshot.nodes.filter(node => node.successCriteria.length > 0).map(node => [node.key, node.successCriteria]))
}

export function projectCurrentTaskGraph(
  items: readonly TimelineItem[],
  scopedTasks: readonly SupervisorTaskSummary[],
  sessionId: string,
): TaskGraphPlan | null {
  if (!sessionId.trim()) return null
  const item = latestTaskGraphItem(items, sessionId)
  const snapshot = item ? parseTaskGraphSnapshot(item.content) : null
  if (!item || !snapshot || snapshot.nodes.length === 0 || !Number.isSafeInteger(item.revision) || item.revision < 1) return null
  const taskIds = new Set(snapshot.nodes.map(node => node.taskId))
  if (item.taskId) taskIds.add(item.taskId)
  return projectPlanLedger({
    sessionId,
    revision: item.revision,
    rootTaskId: item.taskId,
    graph: item.content,
    tasks: scopedTasks.filter(task => taskIds.has(task.id)),
  })
}
