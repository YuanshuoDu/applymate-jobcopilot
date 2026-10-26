import type { TaskGraphState } from "../planning/task-graph.js"
import { parseTaskGraphRepairReceipt, parseTaskGraphVerificationReport, taskGraphVerificationReportMatchesStatus, type TaskGraphScheduleInput } from "./task-graph-command-port.js"
import type { Queryable } from "./pg-store-persistence.js"
import { canonicalTaskGraphJson, parseTaskGraphSnapshot, taskGraphItemId, taskGraphSnapshot, type TaskGraphSnapshot } from "./task-graph-snapshot.js"

export async function validateTaskGraphRepairTargets(
  client: Queryable, input: TaskGraphScheduleInput, current: TaskGraphState, priorTaskIds: ReadonlyMap<string, string>,
): Promise<void> {
  const proposals = input.proposal.nodes.filter(node => node.repairOf)
  if (!proposals.length) return
  const scope = input.scope
  const stored = await client.query(`SELECT item."content" FROM "agent_items" AS item
    JOIN "agent_sessions" AS session ON session."id" = item."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
    WHERE item."id" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND item."taskId" = $4
      AND item."type" = 'task_graph' AND session."userId" = $5 AND turn."userId" = $5 FOR UPDATE OF item`,
  [taskGraphItemId(scope.parentTaskId), scope.sessionId, scope.turnId, scope.parentTaskId, scope.userId])
  const snapshot = stored.rows[0] ? parseTaskGraphSnapshot((stored.rows[0] as Record<string, unknown>).content) : undefined
  if (!snapshot || canonicalTaskGraphJson(snapshot) !== canonicalTaskGraphJson(taskGraphSnapshot(current, priorTaskIds))) throw new Error("task_graph_repair_snapshot_invalid")
  for (const proposal of proposals) {
    const relation = proposal.repairOf!
    const target = snapshot.nodes.find(node => node.key === relation.nodeKey)
    const ids = target?.verification?.criteria.map(item => item.id) ?? []
    if (relation.graphRootTaskId !== scope.rootTaskId || !target || target.taskId !== relation.taskId
      || target.verificationDisposition !== "typed" || !target.verification || !ids.length) throw new Error("task_graph_repair_target_unresolved")
    const result = await client.query(`SELECT task."id", task."status", task."role", task."failureReason", task."result",
        task."rootTaskId", task."parentTaskId", task."sessionId", task."turnId"
      FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
      JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
      WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
        AND task."parentTaskId" = $5 AND session."userId" = $6 AND turn."userId" = $6 FOR UPDATE OF task`,
    [target.taskId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId])
    const row = result.rows[0] as Record<string, unknown> | undefined
    const report = parseTaskGraphVerificationReport(object(row?.result)?.taskGraphVerificationReport, ids)
    if (!row || row.id !== relation.taskId || row.status !== "failed" || row.role !== input.templates[proposal.templateId]?.role
      || row.rootTaskId !== scope.rootTaskId || row.parentTaskId !== scope.parentTaskId || row.sessionId !== scope.sessionId
      || row.turnId !== scope.turnId || !report || !taskGraphVerificationReportMatchesStatus(report, "failed")
      || row.failureReason !== `task_graph_verification_${report.status}`) throw new Error("task_graph_repair_target_unresolved")
    const statuses = new Map(report.criteria.map(item => [item.criterionId, item.status] as const))
    if (!relation.criterionIds.every(id => statuses.get(id) === "failed" || statuses.get(id) === "unverified")) throw new Error("task_graph_repair_criteria_resolved")
    const priorRepairs = snapshot.nodes.filter(node => node.repairOf?.graphRootTaskId === relation.graphRootTaskId
      && node.repairOf.nodeKey === relation.nodeKey && node.repairOf.taskId === relation.taskId)
    if (priorRepairs.length && await hasResolvingRepairReceipt(client, scope, priorRepairs, relation.criterionIds)) {
      throw new Error("task_graph_repair_criteria_resolved")
    }
  }
}

async function hasResolvingRepairReceipt(
  client: Queryable, scope: TaskGraphScheduleInput["scope"], repairs: TaskGraphSnapshot["nodes"], criterionIds: readonly string[],
): Promise<boolean> {
  const result = await client.query(`SELECT task."id", task."status", task."result" FROM "sub_agent_tasks" AS task
    JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3
      AND task."rootTaskId" = $4 AND task."parentTaskId" = $5 AND session."userId" = $6 AND turn."userId" = $6`,
  [repairs.map(node => node.taskId), scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId])
  const byId = new Map(result.rows.map(value => { const row = value as Record<string, unknown>; return [String(row.id), row] as const }))
  if (byId.size !== repairs.length) throw new Error("task_graph_repair_target_scope_invalid")
  for (const repair of repairs) {
    const row = byId.get(repair.taskId)!, ids = repair.verification?.criteria.map(item => item.id) ?? []
    const resultValue = object(row.result)
    const report = parseTaskGraphVerificationReport(resultValue?.taskGraphVerificationReport, ids)
    const receipt = parseTaskGraphRepairReceipt(resultValue?.taskGraphRepairReceipt, {
      repairOf: repair.repairOf, repairNodeKey: repair.key, repairTaskId: repair.taskId, report,
    })
    if (row.status === "completed" && report?.status === "passed" && taskGraphVerificationReportMatchesStatus(report, "completed")
      && receipt?.criterionIds.some(id => criterionIds.includes(id))) return true
  }
  return false
}

function object(value: unknown): Record<string, unknown> | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
}
