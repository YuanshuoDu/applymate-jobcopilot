import type { Queryable } from "./pg-store-persistence.js"
import type { GraphTaskRow } from "./task-graph-pg-state.js"
import type { StoredTaskGraphNode } from "./task-graph-snapshot.js"

/** A repair receipt satisfies its typed target; it does not replace dependency lineage. */
export function hasCompletedLegacyAncestor(key: string, nodes: ReadonlyMap<string, StoredTaskGraphNode>, tasks: ReadonlyMap<string, GraphTaskRow>): boolean {
  const node = nodes.get(key)
  if (!node) return false
  if (node.verificationDisposition === "legacy_unverified" && tasks.get(node.taskId)?.status === "completed") return true
  return node.verificationDisposition === "typed" && node.dependsOn.some(dependency => hasCompletedLegacyAncestor(dependency, nodes, tasks))
}

export function isActiveGraphStatus(status: string): boolean {
  return status === "queued" || status === "retrying" || status === "waiting"
    || status === "waiting_for_user" || status === "running"
}

/** Delete only unpublished dispatch; a published delivery is fenced by claim ownership. */
export async function deleteGraphDispatch(client: Queryable, sessionId: string, taskId: string): Promise<void> {
  await client.query(`DELETE FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
    AND "aggregateId" = $1 AND "idempotencyKey" = $2 AND "publishedAt" IS NULL`,
  [sessionId, `subagent-dispatch:${taskId}`])
}
