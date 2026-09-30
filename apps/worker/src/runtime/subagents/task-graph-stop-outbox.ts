import { reduceTaskGraphEvent, type TaskGraphEvent, type TaskGraphEventType } from "../planning/task-graph.js"
import { transaction, type Queryable } from "./pg-store-persistence.js"
import { writeTaskLifecycleReceipt } from "./task-graph-pg-events.js"
import { loadTaskGraph, type GraphIdentityScope } from "./task-graph-pg-state.js"
import { parseTaskGraphEvent, taskGraphLifecycleKey, taskGraphState } from "./task-graph-snapshot.js"
import type { PgSubagentPool, SubagentTaskStatus } from "./types.js"

export const TASK_GRAPH_STOP_OUTBOX_TOPIC = "agent.task-graph.stop"
const DEFAULT_BATCH_SIZE = 10
const MAX_BATCH_SIZE = 50
const DEFAULT_POLL_MS = 1_000
const PROCESSING_ERROR = "processing_error"

type StopPayload = Readonly<{ sessionId: string; turnId: string }>
type OutboxRow = Readonly<{ id: string; aggregateId: string; payload: unknown; publishedAt: Date | string | null }>
type StopTaskRow = Readonly<{ id: string; status: string; attemptCount: number; interruptRequestedAt: Date | string | null }>
type StartOptions = {
  pollMs?: number
  drain?: (pool: PgSubagentPool, batchSize?: number) => Promise<number>
}

function object(value: unknown): Record<string, unknown> | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
}

function parsePayload(value: unknown): StopPayload | null {
  const row = object(value)
  if (!row || Object.keys(row).sort().join(",") !== "sessionId,turnId"
    || typeof row.sessionId !== "string" || !row.sessionId.trim()
    || typeof row.turnId !== "string" || !row.turnId.trim()) return null
  return { sessionId: row.sessionId, turnId: row.turnId }
}

function boundedBatchSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_BATCH_SIZE
  if (!Number.isInteger(value) || value < 1) throw new RangeError("TaskGraph stop outbox batch size must be positive")
  return Math.min(MAX_BATCH_SIZE, value)
}

function graphStatus(type: TaskGraphEventType): SubagentTaskStatus {
  switch (type) {
    case "task.started": return "running"
    case "task.queued": return "queued"
    case "task.waiting": return "waiting"
    case "task.waiting_for_user": return "waiting_for_user"
    case "task.retrying": return "queued"
    case "task.completed": return "completed"
    case "task.failed": return "failed"
    case "task.interrupted": return "interrupted"
    case "task.cancelled": return "cancelled"
    case "task.closed": return "closed"
  }
}

function latestByNode(events: readonly TaskGraphEvent[]): Map<string, TaskGraphEvent> {
  const latest = new Map<string, TaskGraphEvent>()
  for (const event of events) latest.set(event.nodeKey, event)
  return latest
}

async function persistedLifecycleEvents(client: Queryable, scope: GraphIdentityScope, itemId: string): Promise<TaskGraphEvent[]> {
  const result = await client.query(`SELECT event."payload" FROM "agent_events" AS event
    JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."itemId" = $3
      AND event."type" = 'item.delta' AND session."userId" = $4 AND turn."userId" = $4
    ORDER BY event."sequence" ASC`, [scope.sessionId, scope.turnId, itemId, scope.userId])
  const events: TaskGraphEvent[] = []
  for (const raw of result.rows) {
    const payload = object((raw as Record<string, unknown>).payload)
    if (payload?.kind !== "lifecycle") continue
    const event = parseTaskGraphEvent(payload.event)
    if (!event) throw new Error("task_graph_stop_history_invalid")
    events.push(event)
  }
  return events
}

async function stoppedTask(client: Queryable, scope: GraphIdentityScope, taskId: string): Promise<StopTaskRow> {
  const result = await client.query(`SELECT task."id", task."status", task."attemptCount", task."interruptRequestedAt"
    FROM "sub_agent_tasks" AS task
    JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3
      AND task."rootTaskId" = $4 AND task."parentTaskId" = $5
      AND session."userId" = $6 AND turn."userId" = $6
    FOR UPDATE OF task`, [taskId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId])
  const row = result.rows[0] as StopTaskRow | undefined
  if (!row) throw new Error("task_graph_stop_task_scope_invalid")
  return row
}

async function verifyStoppedTask(client: Queryable, scope: GraphIdentityScope, taskId: string): Promise<void> {
  const result = await client.query(`SELECT task."id" FROM "sub_agent_tasks" AS task
    JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3
      AND task."rootTaskId" = $4 AND task."parentTaskId" = $5
      AND task."status" = 'interrupted' AND task."interruptRequestedAt" IS NOT NULL
      AND session."userId" = $6 AND turn."userId" = $6 FOR UPDATE OF task`,
  [taskId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId])
  if (result.rowCount !== 1) throw new Error("task_graph_stop_marker_unavailable")
}

async function deletePendingGraphDispatch(client: Queryable, sessionId: string, taskId: string): Promise<void> {
  await client.query(`DELETE FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
    AND "aggregateId" = $1 AND "idempotencyKey" = $2 AND "publishedAt" IS NULL`,
  [sessionId, `subagent-dispatch:${taskId}`])
}

/** Projects Web's durable Stop intent through the canonical TaskGraph lifecycle receipt writer. */
export async function projectTaskGraphStopIntent(client: Queryable, payload: StopPayload): Promise<void> {
  const identity = await client.query(`SELECT session."userId", turn."rootTaskId", turn."status" AS "turnStatus"
    FROM "agent_sessions" AS session
    JOIN "agent_turns" AS turn ON turn."sessionId" = session."id" AND turn."userId" = session."userId"
    WHERE session."id" = $1 AND turn."id" = $2 FOR UPDATE OF session, turn`, [payload.sessionId, payload.turnId])
  const row = identity.rows[0] as Record<string, unknown> | undefined
  if (!row || typeof row.userId !== "string" || row.turnStatus !== "interrupted") throw new Error("task_graph_stop_turn_scope_invalid")
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [row.userId])
  if (typeof row.rootTaskId !== "string" || !row.rootTaskId) return

  const scope: GraphIdentityScope = {
    userId: row.userId, sessionId: payload.sessionId, turnId: payload.turnId,
    rootTaskId: row.rootTaskId, parentTaskId: row.rootTaskId,
  }
  let loaded = await loadTaskGraph(client, scope, true)
  if (!loaded.item || !loaded.snapshot || !loaded.state) return

  for (const node of loaded.snapshot.nodes) {
    const task = await stoppedTask(client, scope, node.taskId)
    if (task.interruptRequestedAt === null) continue
    await deletePendingGraphDispatch(client, scope.sessionId, task.id)
    if (task.status === "running") continue
    if (task.status !== "interrupted") {
      if (["completed", "failed", "cancelled", "closed"].includes(task.status)) continue
      throw new Error("task_graph_stop_status_inconsistent")
    }

    await verifyStoppedTask(client, scope, task.id)
    loaded = await loadTaskGraph(client, scope, true)
    if (!loaded.item || !loaded.snapshot || !loaded.state) throw new Error("task_graph_stop_snapshot_unavailable")
    const events = await persistedLifecycleEvents(client, scope, loaded.item.id)
    const latestEvent = latestByNode(events).get(node.key)
    if (latestEvent && graphStatus(latestEvent.type) === "interrupted") continue
    if (latestEvent && ["completed", "failed", "cancelled", "closed"].includes(graphStatus(latestEvent.type))) {
      throw new Error("task_graph_stop_terminal_history_conflict")
    }

    const previousStatus = latestEvent
      ? graphStatus(latestEvent.type)
      : node.dependsOn.length === 0 ? "queued" : "waiting"
    if (!["queued", "running", "retrying", "waiting", "waiting_for_user"].includes(previousStatus)) {
      throw new Error("task_graph_stop_prestate_invalid")
    }
    const statuses = new Map([...loaded.tasks].map(([id, current]) => [id, {
      status: current.status, failureReason: current.failureReason,
    }] as const))
    statuses.set(node.taskId, { status: previousStatus, failureReason: null })
    const state = taskGraphState(loaded.snapshot, loaded.item.revision, statuses, events)
    const event: TaskGraphEvent = {
      idempotencyKey: taskGraphLifecycleKey(scope.parentTaskId, node.key, Number(task.attemptCount), "task.interrupted"),
      expectedRevision: state.revision, nodeKey: node.key, type: "task.interrupted",
    }
    const reduced = reduceTaskGraphEvent(state, event)
    if (!reduced.ok) throw new Error(`task_graph_stop_transition_rejected:${reduced.error.code}`)
    if (reduced.duplicate) continue

    await verifyStoppedTask(client, scope, task.id)
    const revision = await writeTaskLifecycleReceipt(
      client, scope, loaded.item.id, task.id, event, state.revision, loaded.snapshot, new Date(),
      { stream: true, allowClosedSession: true },
    )
    if (revision !== reduced.state.revision) throw new Error("task_graph_stop_revision_mismatch")
  }
}

async function markRetry(pool: PgSubagentPool, id: string): Promise<void> {
  await transaction(pool, async client => {
    await client.query(`UPDATE "agent_outbox" SET "attemptCount" = "attemptCount" + 1, "lastError" = $2
      WHERE "id" = $1 AND "topic" = $3 AND "publishedAt" IS NULL`, [id, PROCESSING_ERROR, TASK_GRAPH_STOP_OUTBOX_TOPIC])
  })
}

async function processRow(pool: PgSubagentPool, id: string): Promise<boolean> {
  try {
    return await transaction(pool, async client => {
      const result = await client.query<OutboxRow>(`SELECT "id", "aggregateId", "payload", "publishedAt"
        FROM "agent_outbox" WHERE "id" = $1 AND "topic" = $2 FOR UPDATE`, [id, TASK_GRAPH_STOP_OUTBOX_TOPIC])
      const row = result.rows[0]
      if (!row || row.publishedAt !== null) return false
      const payload = parsePayload(row.payload)
      if (!payload || row.aggregateId !== payload.sessionId) throw new Error("task_graph_stop_outbox_scope_invalid")
      await projectTaskGraphStopIntent(client, payload)
      await client.query(`UPDATE "agent_outbox" SET "publishedAt" = CURRENT_TIMESTAMP,
          "attemptCount" = "attemptCount" + 1, "lastError" = NULL
        WHERE "id" = $1 AND "topic" = $2 AND "publishedAt" IS NULL`, [row.id, TASK_GRAPH_STOP_OUTBOX_TOPIC])
      return true
    })
  } catch {
    await markRetry(pool, id).catch(() => undefined)
    return false
  }
}

export async function drainTaskGraphStopOutbox(pool: PgSubagentPool, batchSize?: number): Promise<number> {
  const result = await transaction(pool, client => client.query<{ id: string }>(`SELECT "id" FROM "agent_outbox"
    WHERE "topic" = $1 AND "publishedAt" IS NULL
    ORDER BY "createdAt" ASC, "id" ASC LIMIT $2 FOR UPDATE SKIP LOCKED`, [TASK_GRAPH_STOP_OUTBOX_TOPIC, boundedBatchSize(batchSize)]))
  let processed = 0
  for (const row of result.rows) if (await processRow(pool, row.id)) processed++
  return processed
}

export function startTaskGraphStopOutboxConsumer(pool: PgSubagentPool, options: StartOptions = {}) {
  const pollMs = Number(options.pollMs ?? process.env.AGENT_TASK_GRAPH_STOP_OUTBOX_POLL_MS ?? DEFAULT_POLL_MS)
  const drain = options.drain ?? drainTaskGraphStopOutbox
  let closed = false
  let inFlight: Promise<void> | null = null
  const run = () => {
    if (closed || inFlight) return
    const current = drain(pool).then(() => undefined).catch(error => {
      console.error("[agent-task-graph-stop-outbox] drain failed:", error)
    }).finally(() => { if (inFlight === current) inFlight = null })
    inFlight = current
  }
  const timer = setInterval(run, Number.isFinite(pollMs) && pollMs >= 250 && pollMs <= 30_000 ? pollMs : DEFAULT_POLL_MS)
  timer.unref?.()
  run()
  return { async close() { closed = true; clearInterval(timer); await inFlight } }
}
