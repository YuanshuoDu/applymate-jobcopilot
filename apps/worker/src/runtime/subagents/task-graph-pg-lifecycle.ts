import { reduceTaskGraphEvent, type TaskGraphEvent, type TaskGraphEventType, type TaskGraphState } from "../planning/task-graph.js"
import type { Queryable } from "./pg-store-persistence.js"
import { hasPersistedTaskGraphMembership, loadTaskGraph, type GraphIdentityScope } from "./task-graph-pg-state.js"
import { sanitizeTaskGraphLifecycleEvent, writeTaskLifecycleReceipt } from "./task-graph-pg-events.js"
import { taskGraphLifecycleKey } from "./task-graph-snapshot.js"
import { isTaskGraphDependencyContextError, materializeTaskGraphDependencyContext } from "./task-graph-dependency-context.js"
import { loadScopedTaskGraphDependencyContext } from "./task-graph-pg-dependency-context-loader.js"
import { enqueueReadyGraphTask } from "./task-graph-pg-dispatch.js"

export type PreparedGraphTransition = Readonly<{
  scope: GraphIdentityScope
  itemId: string
  taskId: string
  expectedRevision: number
  snapshot: NonNullable<Awaited<ReturnType<typeof loadTaskGraph>>["snapshot"]>
  event: TaskGraphEvent
  state: TaskGraphState
  duplicate: boolean
}>
export type GraphTransitionPreparation = PreparedGraphTransition | Readonly<{ blocked: true }> | null

export function taskGraphEventType(status: string, retry: boolean): TaskGraphEventType | null {
  if (retry) return "task.retrying"
  switch (status) {
    case "completed": return "task.completed"
    case "failed": return "task.failed"
    case "interrupted": return "task.interrupted"
    case "cancelled": return "task.cancelled"
    case "closed": return "task.closed"
    case "waiting": return "task.waiting"
    case "waiting_for_user": return "task.waiting_for_user"
    default: return null
  }
}

/** Call after locking the owning session and before changing the SubAgentTask row. */
export async function prepareGraphTransition(client: Queryable, input: {
  taskId: string
  sessionId: string
  type: TaskGraphEventType
  attemptCount?: number
  failureReason?: string
}): Promise<GraphTransitionPreparation> {
  const identity = await client.query(`SELECT task."turnId", task."rootTaskId", task."parentTaskId", task."attemptCount", session."userId"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2`, [input.taskId, input.sessionId])
  const row = identity.rows[0] as Record<string, unknown> | undefined
  if (!row || typeof row.userId !== "string" || typeof row.turnId !== "string"
    || typeof row.rootTaskId !== "string" || row.parentTaskId !== row.rootTaskId) return null
  const scope: GraphIdentityScope = {
    userId: row.userId, sessionId: input.sessionId, turnId: row.turnId,
    rootTaskId: row.rootTaskId, parentTaskId: row.rootTaskId,
  }
  if (!await hasPersistedTaskGraphMembership(client, scope, input.taskId)) return null
  const loaded = await loadTaskGraph(client, scope, true)
  if (!loaded.item || !loaded.snapshot || !loaded.state) throw new Error("task_graph_state_missing")
  const node = loaded.snapshot.nodes.find(candidate => candidate.taskId === input.taskId)
  if (!node) throw new Error("task_graph_child_missing")
  const attemptCount = input.attemptCount ?? Number(row.attemptCount) + (input.type === "task.started" ? 1 : 0)
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 0) throw new Error("task_graph_attempt_count_invalid")
  const event = sanitizeTaskGraphLifecycleEvent(makeEvent({ ...input, attemptCount }, node.key, loaded.state.revision, scope.parentTaskId))
  const reduced = reduceTaskGraphEvent(loaded.state, event)
  if (!reduced.ok) {
    if (reduced.error.code === "dependencies_incomplete" || reduced.error.code === "blocked_dependency") return { blocked: true }
    throw new Error(`task_graph_transition_rejected:${reduced.error.code}`)
  }
  return {
    scope, itemId: loaded.item.id, taskId: input.taskId, expectedRevision: loaded.state.revision,
    snapshot: loaded.snapshot, event, state: reduced.state, duplicate: reduced.duplicate,
  }
}

export async function persistGraphTransition(client: Queryable, prepared: PreparedGraphTransition, now: Date, options: { stream?: boolean; allowClosedSession?: boolean } = {}): Promise<TaskGraphState> {
  if (prepared.duplicate) return prepared.state
  const revision = await writeTaskLifecycleReceipt(
    client, prepared.scope, prepared.itemId, prepared.taskId, prepared.event,
    prepared.expectedRevision, prepared.snapshot, now, options,
  )
  if (revision !== prepared.state.revision) throw new Error("task_graph_revision_transition_mismatch")
  return prepared.state
}

/** Promote only fully satisfied joins and terminalize every blocked waiter. */
export async function reconcileGraphDependents(
  client: Queryable,
  scope: GraphIdentityScope,
  now: Date,
  options: { stream?: boolean; allowClosedSession?: boolean } = {},
): Promise<void> {
  for (let pass = 0; pass < 8; pass++) {
    const loaded = await loadTaskGraph(client, scope, true)
    if (!loaded.item || !loaded.snapshot || !loaded.state) throw new Error("task_graph_state_missing")
    const taskByKey = new Map(loaded.snapshot.nodes.map(node => [node.key, loaded.tasks.get(node.taskId)!] as const))
    const nodes = [...loaded.state.nodes].sort((left, right) => left.depth - right.depth)
    let changed = false
    const blockedKeys = new Set<string>()
    for (const node of nodes) {
      const dependencyStatuses = node.dependsOn.map(key => taskByKey.get(key)?.status)
      const blocked = node.dependsOn.some((key, index) => {
        const status = dependencyStatuses[index]
        return status === "failed" || status === "interrupted" || status === "cancelled" || status === "closed" || blockedKeys.has(key)
      })
      if (blocked) blockedKeys.add(node.key)
      const row = taskByKey.get(node.key)
      if (!row) continue
      if (options.allowClosedSession && isActiveGraphStatus(row.status)) {
        if (row.status === "running") {
          await client.query(`UPDATE "sub_agent_tasks" SET "interruptRequestedAt" = COALESCE("interruptRequestedAt", $6), "updatedAt" = $6
            WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4
              AND "parentTaskId" = $5 AND "status" = 'running'
              AND EXISTS (SELECT 1 FROM "agent_sessions" AS session WHERE session."id" = $2 AND session."userId" = $7)`,
          [row.id, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, now, scope.userId])
          continue
        }
        const transition = await prepareGraphTransition(client, {
          taskId: row.id, sessionId: scope.sessionId, type: "task.interrupted",
        })
        if (!transition) throw new Error("task_graph_child_missing")
        if ("blocked" in transition) continue
        const updated = await client.query(`UPDATE "sub_agent_tasks" SET "status" = 'interrupted',
          "interruptRequestedAt" = COALESCE("interruptRequestedAt", $6), "leaseOwner" = NULL,
          "leaseExpiresAt" = NULL, "nextAttemptAt" = NULL, "completedAt" = $6, "updatedAt" = $6
          WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4
            AND "parentTaskId" = $5 AND "status" = $7
            AND EXISTS (SELECT 1 FROM "agent_sessions" AS session WHERE session."id" = $2 AND session."userId" = $8)` ,
        [row.id, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, now, row.status, scope.userId])
        if (updated.rowCount === 1) {
          await deleteGraphDispatch(client, scope.sessionId, row.id)
          await persistGraphTransition(client, transition, now, options)
          changed = true
        }
        continue
      }
      if (row.status !== "waiting") continue
      if (blocked) {
        const transition = await prepareGraphTransition(client, { taskId: row.id, sessionId: scope.sessionId, type: "task.cancelled" })
        if (!transition) throw new Error("task_graph_child_missing")
        if ("blocked" in transition) continue
        const updated = await client.query(`UPDATE "sub_agent_tasks" SET "status" = 'cancelled',
          "failureReason" = 'A prerequisite task did not complete.', "nextAttemptAt" = NULL,
          "completedAt" = $6, "updatedAt" = $6 WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3
            AND "rootTaskId" = $4 AND "parentTaskId" = $5 AND "status" = 'waiting'
            AND EXISTS (SELECT 1 FROM "agent_sessions" AS session WHERE session."id" = $2 AND session."userId" = $7)`,
        [row.id, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, now, scope.userId])
        if (updated.rowCount === 1) {
          await persistGraphTransition(client, transition, now, options)
          changed = true
        }
        continue
      }
      if (options.allowClosedSession) continue
      if (!node.dependsOn.every(key => taskByKey.get(key)?.status === "completed")) continue
      const transition = await prepareGraphTransition(client, { taskId: row.id, sessionId: scope.sessionId, type: "task.queued" })
      if (!transition) throw new Error("task_graph_child_missing")
      if ("blocked" in transition) continue
      let dependencyContext: unknown
      try {
        const contextRows = await loadScopedTaskGraphDependencyContext(client, scope, row.id, node.dependsOn, loaded.snapshot.nodes)
        dependencyContext = materializeTaskGraphDependencyContext(
          contextRows.childContext, scope, node.dependsOn, contextRows.dependencies,
        )
      } catch (error) {
        if (!isTaskGraphDependencyContextError(error)) throw error
        // A malformed/oversized predecessor must not roll back its completion
        // and trap the graph in an endless retry loop. Terminalize this waiter
        // with a generic reason, then let reconciliation cancel its descendants.
        const cancelled = await prepareGraphTransition(client, { taskId: row.id, sessionId: scope.sessionId, type: "task.cancelled" })
        if (!cancelled) throw new Error("task_graph_child_missing")
        if ("blocked" in cancelled) continue
        const rejected = await client.query(`UPDATE "sub_agent_tasks" SET "status" = 'cancelled',
            "failureReason" = 'Prerequisite results could not be safely materialized.',
            "nextAttemptAt" = NULL, "completedAt" = $6, "updatedAt" = $6
          WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4
            AND "parentTaskId" = $5 AND "status" = 'waiting'
            AND EXISTS (SELECT 1 FROM "agent_sessions" AS session WHERE session."id" = $2 AND session."userId" = $7)`,
        [row.id, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, now, scope.userId])
        if (rejected.rowCount === 1) {
          await deleteGraphDispatch(client, scope.sessionId, row.id)
          await persistGraphTransition(client, cancelled, now, options)
          changed = true
        }
        continue
      }
      const updated = await client.query(`UPDATE "sub_agent_tasks" SET "context" = $6::jsonb,
          "status" = 'queued', "nextAttemptAt" = NULL, "updatedAt" = $7
        WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4
          AND "parentTaskId" = $5 AND "status" = 'waiting'
          AND EXISTS (SELECT 1 FROM "agent_sessions" AS session WHERE session."id" = $2 AND session."userId" = $8)`,
      [row.id, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, JSON.stringify(dependencyContext), now, scope.userId])
      if (updated.rowCount === 1) {
        await persistGraphTransition(client, transition, now, options)
        await enqueueReadyGraphTask(client, scope, row.id)
        changed = true
      }
    }
    if (!changed) return
  }
  throw new Error("task_graph_dependency_reconciliation_limit")
}

function isActiveGraphStatus(status: string): boolean {
  return status === "queued" || status === "retrying" || status === "waiting"
    || status === "waiting_for_user" || status === "running"
}

async function deleteGraphDispatch(client: Queryable, sessionId: string, taskId: string): Promise<void> {
  await client.query(`DELETE FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
    AND "aggregateId" = $1 AND "idempotencyKey" = $2 AND "publishedAt" IS NULL`,
  [sessionId, `subagent-dispatch:${taskId}`])
}

function makeEvent(input: { type: TaskGraphEventType; attemptCount: number; failureReason?: string }, nodeKey: string, expectedRevision: number, parentTaskId: string): TaskGraphEvent {
  const idempotencyKey = taskGraphLifecycleKey(parentTaskId, nodeKey, input.attemptCount, input.type)
  if (input.type === "task.failed") return {
    idempotencyKey, expectedRevision, nodeKey, type: input.type,
    failureReason: input.failureReason || "Child task failed.",
  }
  return { idempotencyKey, expectedRevision, nodeKey, type: input.type }
}
