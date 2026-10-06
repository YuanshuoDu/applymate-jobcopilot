import type pg from "pg"
import { taskGraphResultDigest } from "./task-graph-pg-verification.js"
import { canonicalNativeVerificationJson } from "./native-verification-contract.js"
import type { TaskGraphNativeSourceProvenance } from "./task-graph-command-port.js"
import type { TaskGraphReadScope } from "./task-graph-command-port.js"
import type { TaskGraphSnapshot } from "./task-graph-snapshot.js"
import type { NativeVerificationTask } from "./native-verification-pg-bindings.js"

type Row = Record<string, unknown>
type Queryable = Pick<pg.PoolClient, "query">
const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "closed"])

/** Reads the exact durable source rows for every native followup in a snapshot. */
export async function loadNativeVerificationSourceTasks(
  client: Queryable, scope: TaskGraphReadScope, snapshot: TaskGraphSnapshot | null, lockTargets: boolean,
): Promise<ReadonlyMap<string, NativeVerificationTask>> {
  const sources = (snapshot?.nodes ?? []).flatMap(node => node.nativeDelegation?.source ? [node.nativeDelegation.source] : [])
  const sourceIds = [...new Set(sources.map(source => source.taskId))]
  const result = sourceIds.length ? await client.query(`SELECT task."id", task."parentTaskId", task."rootTaskId", task."turnId", task."role", task."taskType",
      task."status", task."attemptCount", task."result", task."failureReason", task."goal", task."successCriteria"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3
      AND task."rootTaskId" = $4 AND session."userId" = $5 AND turn."userId" = $5
    ORDER BY task."id"${lockTargets ? " FOR UPDATE OF task" : ""}`,
  [sourceIds, scope.sessionId, scope.turnId, scope.rootTaskId, scope.userId]) : { rows: [] as Row[] }
  if (result.rows.length !== sourceIds.length) throw new Error("native_verification_source_scope_invalid")
  const tasks = new Map<string, NativeVerificationTask>()
  for (const raw of result.rows) {
    const row = raw as Row
    if (typeof row.id !== "string" || typeof row.rootTaskId !== "string" || typeof row.status !== "string"
      || typeof row.role !== "string" || typeof row.taskType !== "string"
      || !Number.isSafeInteger(row.attemptCount) || Number(row.attemptCount) < 0
      || typeof row.goal !== "string" || row.goal.trim() !== row.goal) {
      throw new Error("native_verification_source_shape_invalid")
    }
    tasks.set(row.id, {
      id: row.id, parentTaskId: typeof row.parentTaskId === "string" ? row.parentTaskId : null,
      rootTaskId: row.rootTaskId, turnId: typeof row.turnId === "string" ? row.turnId : null,
      role: row.role, taskType: row.taskType, status: row.status, attemptCount: Number(row.attemptCount),
      result: row.result ?? null, failureReason: typeof row.failureReason === "string" ? row.failureReason : null,
      goal: row.goal, successCriteria: row.successCriteria ?? null,
      expectedOutputSchema: {}, context: {}, outputArtifactIds: [],
    })
  }
  return tasks
}

/** Validates live source ownership and attempt/result provenance, including legacy sources. */
export function nativeVerificationSourceIsCurrent(
  snapshot: TaskGraphSnapshot | null, source: TaskGraphNativeSourceProvenance,
  task: NativeVerificationTask | undefined, scope: TaskGraphReadScope,
): boolean {
  if (!task || task.id !== source.taskId || task.rootTaskId !== source.rootTaskId || task.parentTaskId !== source.parentTaskId
    || task.turnId !== source.turnId || task.role !== source.role || task.taskType !== source.taskType
    || task.status !== source.status || task.attemptCount !== source.attemptCount
    || task.rootTaskId !== scope.rootTaskId || task.turnId !== scope.turnId || !TERMINAL.has(task.status)
    || taskGraphResultDigest(task.result) !== source.resultDigest) return false
  if (source.origin === "task_graph") {
    const node = snapshot?.nodes.find(candidate => candidate.key === source.graphNodeKey)
    try {
      return Boolean(node && node.taskId === task.id && node.goal === task.goal
        && canonicalNativeVerificationJson(node.successCriteria) === canonicalNativeVerificationJson(task.successCriteria))
    } catch { return false }
  }
  return source.origin === "native_legacy" && source.graphNodeKey === null
    && !(snapshot?.nodes.some(node => node.taskId === task.id) ?? false)
}
