import type { Queryable } from "./pg-store-persistence.js"
import type { ScopedDependencyResult } from "./task-graph-dependency-context.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"

/** Read a waiting task's template context and its direct predecessors under one exact graph scope. */
export async function loadScopedTaskGraphDependencyContext(
  client: Queryable,
  scope: GraphIdentityScope,
  childTaskId: string,
  dependencyKeys: readonly string[],
  graphNodes: readonly { key: string; taskId: string }[],
): Promise<{ childContext: unknown; dependencies: ScopedDependencyResult[] }> {
  const taskIdByKey = new Map(graphNodes.map(node => [node.key, node.taskId] as const))
  const ids = [childTaskId, ...dependencyKeys.map(key => taskIdByKey.get(key)).filter((id): id is string => Boolean(id))]
  const result = await client.query(`SELECT task."id", task."status", task."role", task."expectedOutputSchema", task."result", task."context",
      task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", session."userId" AS "userId"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3
      AND task."rootTaskId" = $4 AND task."parentTaskId" = $5 AND session."userId" = $6 AND turn."userId" = $6`,
  [ids, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId])
  const byId = new Map(result.rows.map(raw => {
    const row = raw as Record<string, unknown>
    return [String(row.id), row] as const
  }))
  const child = byId.get(childTaskId)
  if (!child || child.status !== "waiting") throw new Error("task_graph_dependency_child_scope_invalid")
  const dependencies: ScopedDependencyResult[] = []
  for (const key of dependencyKeys) {
    const taskId = taskIdByKey.get(key)
    const row = taskId ? byId.get(taskId) : undefined
    if (!taskId || !row) continue
    dependencies.push({
      key, taskId, status: String(row.status), role: String(row.role),
      expectedOutputSchema: row.expectedOutputSchema, result: row.result,
      userId: String(row.userId), sessionId: String(row.sessionId), turnId: String(row.turnId),
      rootTaskId: String(row.rootTaskId), parentTaskId: String(row.parentTaskId),
    })
  }
  return { childContext: child.context ?? {}, dependencies }
}
