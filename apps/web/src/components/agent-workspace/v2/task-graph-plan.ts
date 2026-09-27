import { projectPlanLedger, type PlanLedger, type PlanLedgerEvidencePreview, type PlanLedgerReadiness, type PlanLedgerStatus } from '@jobcopilot/agent-protocol'
import type { TimelineItem } from './timeline-reducer'
import type { SupervisorTaskSummary } from './task-tree-projection'
import { latestTaskGraphItem } from './task-graph-plan-query'
import { parseTaskGraphSnapshot } from './task-graph-plan-snapshot'

export { parseTaskGraphSnapshot } from './task-graph-plan-snapshot'
export type TaskGraphPlanStatus = PlanLedgerStatus
export type TaskGraphPlanReadiness = PlanLedgerReadiness
export type TaskGraphEvidencePreview = PlanLedgerEvidencePreview
export type TaskGraphPlanNode = PlanLedger['nodes'][number]
export type TaskGraphPlan = PlanLedger

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
    graph: { schemaVersion: 'agent-harness.v2.task-graph', nodes: snapshot.nodes },
    tasks: scopedTasks.filter(task => taskIds.has(task.id)),
  })
}
