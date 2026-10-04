import { deriveTaskGraphReadModel, reduceTaskGraphEvent, type TaskGraphEvent, type TaskGraphEventType, type TaskGraphState } from "../planning/task-graph.js"
import type { Queryable } from "./pg-store-persistence.js"
import { hasPersistedTaskGraphMembership, loadTaskGraph, type GraphIdentityScope, type GraphTaskRow } from "./task-graph-pg-state.js"
import { sanitizeTaskGraphLifecycleEvent, writeTaskLifecycleReceipt } from "./task-graph-pg-events.js"
import { taskGraphLifecycleKey, type StoredTaskGraphNode } from "./task-graph-snapshot.js"
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

export const rootRecoveryEligibility = `(task."id" NOT LIKE 'root-%' OR session."status" IN ('aborted','archived') OR task."interruptRequestedAt" IS NOT NULL
  OR (task."taskType" = 'root' AND task."id" = task."rootTaskId" AND task."parentTaskId" IS NULL AND task."turnId" IS NOT NULL
    AND EXISTS (SELECT 1 FROM "agent_turns" turn WHERE turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
      AND turn."userId" = session."userId" AND turn."rootTaskId" = task."id" AND turn."status" = 'failed')))`
export async function lockFailedRootTurn(client: Queryable, task: Record<string, unknown>): Promise<boolean> {
  if (typeof task.id !== "string" || !task.id.startsWith("root-") || task.taskType !== "root"
    || task.id !== task.rootTaskId || task.parentTaskId !== null || typeof task.turnId !== "string" || !task.turnId
    || typeof task.sessionId !== "string" || typeof task.userId !== "string") return false
  const result = await client.query(`SELECT "status" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2
    AND "userId" = $3 AND "rootTaskId" = $4 FOR UPDATE`, [task.turnId, task.sessionId, task.userId, task.id])
  return result.rows[0]?.status === "failed"
}

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
  if (input.type === "task.queued" || input.type === "task.started" || input.type === "task.retrying") {
    const nodesByKey = new Map(loaded.snapshot.nodes.map(candidate => [candidate.key, candidate] as const))
    if (node.dependsOn.some(key => hasCompletedLegacyAncestor(key, nodesByKey, loaded.tasks))) return { blocked: true }
  }
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
    const nodesByKey = new Map(loaded.snapshot.nodes.map(node => [node.key, node] as const))
    const nodes = [...loaded.state.nodes].sort((left, right) => left.depth - right.depth)
    const repairSatisfied = new Set(loaded.state.repairSatisfiedNodeKeys ?? [])
    const readinessState = { ...loaded.state, nodes: loaded.state.nodes.map(node => repairSatisfied.has(node.key) ? { ...node, status: "completed" as const } : node) }
    const readinessByKey = new Map(deriveTaskGraphReadModel(readinessState).map(node => [node.key, node.readiness] as const))
    let changed = false
    for (const node of nodes) {
      const blocked = readinessByKey.get(node.key) === "blocked_dependency"
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
      if (row.status !== "waiting" && row.status !== "queued") continue
      const completedUnverifiedPrerequisite = node.dependsOn.some(key => hasCompletedLegacyAncestor(key, nodesByKey, loaded.tasks))
      if (completedUnverifiedPrerequisite || blocked) {
        const transition = await prepareGraphTransition(client, { taskId: row.id, sessionId: scope.sessionId, type: "task.cancelled" })
        if (!transition) throw new Error("task_graph_child_missing")
        if ("blocked" in transition) continue
        const reason = completedUnverifiedPrerequisite ? "A prerequisite task was not verified." : "A prerequisite task did not complete."
        const updated = await client.query(`UPDATE "sub_agent_tasks" SET "status" = 'cancelled',
          "failureReason" = $6, "nextAttemptAt" = NULL, "completedAt" = $7, "updatedAt" = $7
          WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4
            AND "parentTaskId" = $5 AND "status" = $8
            AND EXISTS (SELECT 1 FROM "agent_sessions" AS session WHERE session."id" = $2 AND session."userId" = $9)`,
        [row.id, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, reason, now, row.status, scope.userId])
        if (updated.rowCount === 1) {
          await deleteGraphDispatch(client, scope.sessionId, row.id)
          await persistGraphTransition(client, transition, now, options)
          changed = true
        }
        continue
      }
      if (row.status === "queued") continue
      if (options.allowClosedSession) continue
      if (!node.dependsOn.every(key => taskByKey.get(key)?.status === "completed" || repairSatisfied.has(key))) continue
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

/** A repair receipt satisfies its typed target; it does not replace that node's dependency lineage. */
function hasCompletedLegacyAncestor(
  key: string,
  nodes: ReadonlyMap<string, StoredTaskGraphNode>,
  tasks: ReadonlyMap<string, GraphTaskRow>,
): boolean {
  const node = nodes.get(key)
  if (!node) return false
  if (node.verificationDisposition === "legacy_unverified" && tasks.get(node.taskId)?.status === "completed") return true
  return node.verificationDisposition === "typed" && node.dependsOn.some(dependency => hasCompletedLegacyAncestor(dependency, nodes, tasks))
}

function isActiveGraphStatus(status: string): boolean {
  return status === "queued" || status === "retrying" || status === "waiting"
    || status === "waiting_for_user" || status === "running"
}

export async function deleteGraphDispatch(client: Queryable, sessionId: string, taskId: string): Promise<void> {
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
