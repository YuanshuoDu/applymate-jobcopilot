import { randomUUID } from "node:crypto"

import type { AgentTreeManager } from "./manager.js"
import { transaction, type Queryable } from "./pg-store-persistence.js"
import { hasPersistedTaskGraphMembership, type GraphIdentityScope } from "./task-graph-pg-state.js"
import { persistGraphTransition, prepareGraphTransition } from "./task-graph-pg-lifecycle.js"
import type { PgSubagentPool } from "./types.js"

export const TASK_INTERRUPT_OUTBOX_TOPIC = "agent.subagent.task-interrupt"
const ACTIVE = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user"])
const ACTIVE_TURN = new Set(["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"])
const BATCH_SIZE = 20
const POLL_MS = 1_000

export type TaskInterruptIntent = Readonly<{ sessionId: string; turnId: string; taskId: string; intentId: string }>
type OutboxRow = Readonly<{ id: string; aggregateId: string; payload: unknown; publishedAt: Date | string | null }>
type TaskRow = Readonly<{ id: string; parentTaskId: string | null; rootTaskId: string; turnId: string; path: string; depth: number; status: string; attemptCount: number; interruptRequestedAt: Date | string | null }>
type StartOptions = { pollMs?: number; drain?: (pool: PgSubagentPool, manager: AgentTreeManager) => Promise<number> }

function record(value: unknown): Record<string, unknown> | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
}

export function parseTaskInterruptIntent(value: unknown): TaskInterruptIntent | null {
  const row = record(value)
  if (!row || Object.keys(row).sort().join(",") !== "intentId,sessionId,taskId,turnId"
    || [row.sessionId, row.turnId, row.taskId, row.intentId].some(value => typeof value !== "string" || !value.trim() || value.length > 128)) return null
  return { sessionId: row.sessionId as string, turnId: row.turnId as string, taskId: row.taskId as string, intentId: row.intentId as string }
}

function key(intent: TaskInterruptIntent, taskId: string, outcome: "interrupted" | "failed"): string {
  return `agent-task-interrupt:${intent.intentId}:${taskId}:${outcome}`
}
async function appendOutcome(client: Queryable, userId: string, intent: TaskInterruptIntent, taskId: string, outcome: "interrupted" | "failed"): Promise<void> {
  const type = outcome === "failed" ? "task.interrupt.failed" : "task.interrupted"
  const idempotencyKey = key(intent, taskId, outcome)
  const prior = await client.query(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "idempotencyKey" = $2`, [intent.sessionId, idempotencyKey])
  if (prior.rows[0]) return
  const sequence = await client.query(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1
    WHERE "id" = $1 AND "userId" = $2 RETURNING "eventSequence"`, [intent.sessionId, userId])
  const eventSequence = sequence.rows[0]?.eventSequence
  if (eventSequence === undefined) throw new Error("task_interrupt_event_session_missing")
  const eventId = randomUUID()
  const payload = outcome === "failed"
    ? { intentId: intent.intentId, taskId, status: "failed", code: "target_unavailable" }
    : { intentId: intent.intentId, taskId, status: "interrupted" }
  const eventPayload = {
    eventId, sessionId: intent.sessionId, turnId: intent.turnId, itemId: null, taskId,
    sequence: String(eventSequence), type, actor: "system", correlationId: intent.intentId,
    causationId: null, idempotencyKey, payload,
  }
  await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload")
    VALUES ($1, $2, $3, NULL, $4, $5, $6, 'system', $7, $8, $9::jsonb)`,
  [eventId, intent.sessionId, intent.turnId, taskId, eventSequence, type, intent.intentId, idempotencyKey, JSON.stringify(payload)])
  await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
    VALUES ($1, 'agent.session.event', $2, $3, $4::jsonb)`, [randomUUID(), intent.sessionId, `agent-event:${eventId}`, JSON.stringify(eventPayload)])
}

async function rejectIntent(client: Queryable, intent: TaskInterruptIntent, userId: string): Promise<void> {
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId])
  const turn = await client.query(`SELECT "id" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 FOR UPDATE`,
    [intent.turnId, intent.sessionId, userId])
  if (turn.rows[0]) await appendOutcome(client, userId, intent, intent.taskId, "failed")
}

function validLineage(chain: readonly TaskRow[], taskId: string, rootTaskId: string): boolean {
  const rows = [...chain].sort((left, right) => left.depth - right.depth)
  let path = ""
  for (const [index, row] of rows.entries()) {
    path = index === 0 ? `/${row.id}` : `${path}/${row.id}`
    if (row.depth !== index || row.path !== path || row.rootTaskId !== rootTaskId
      || row.parentTaskId !== (index === 0 ? null : rows[index - 1]?.id)) return false
  }
  return rows[0]?.id === rootTaskId && rows.at(-1)?.id === taskId && rows.length >= 2
}
async function resolveLineage(client: Queryable, intent: TaskInterruptIntent, userId: string): Promise<{ target: TaskRow; root: Record<string, unknown>; chain: TaskRow[] } | null> {
  const targetResult = await client.query(`SELECT task."id", task."parentTaskId", task."rootTaskId", task."turnId", task."path", task."depth", task."status", task."attemptCount", task."interruptRequestedAt",
      turn."rootTaskId" AS "turnRootTaskId", turn."status" AS "turnStatus", root."id" AS "rootId", root."parentTaskId" AS "rootParentTaskId",
      root."rootTaskId" AS "rootRootTaskId", root."turnId" AS "rootTurnId", root."path" AS "rootPath", root."depth" AS "rootDepth", root."status" AS "rootStatus", root."role" AS "rootRole", root."taskType" AS "rootTaskType"
    FROM "sub_agent_tasks" task JOIN "agent_turns" turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    JOIN "sub_agent_tasks" root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND turn."userId" = $4
    FOR UPDATE OF task, turn, root`, [intent.taskId, intent.sessionId, intent.turnId, userId])
  const identity = targetResult.rows[0] as (TaskRow & Record<string, unknown>) | undefined
  if (!identity || identity.id === identity.rootTaskId || !identity.parentTaskId || identity.turnRootTaskId !== identity.rootTaskId
    || identity.rootId !== identity.rootTaskId || identity.rootParentTaskId !== null || identity.rootRootTaskId !== identity.rootId
    || identity.rootTurnId !== intent.turnId || identity.rootPath !== `/${identity.rootId}` || identity.rootDepth !== 0
    || identity.rootRole !== "orchestrator" || identity.rootTaskType !== "root" || !ACTIVE.has(String(identity.rootStatus))
    || !ACTIVE_TURN.has(String(identity.turnStatus)) || !ACTIVE.has(identity.status) || identity.interruptRequestedAt !== null) return null
  const lineageResult = await client.query(`WITH RECURSIVE chain AS (
      SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", task."path", task."depth", ARRAY[task."id"]::text[] AS "visited"
      FROM "sub_agent_tasks" task WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3
      UNION ALL SELECT parent."id", parent."sessionId", parent."turnId", parent."rootTaskId", parent."parentTaskId", parent."path", parent."depth", child."visited" || parent."id"
      FROM "sub_agent_tasks" parent JOIN chain child ON child."parentTaskId" = parent."id"
      WHERE parent."sessionId" = $2 AND parent."turnId" = $3 AND parent."rootTaskId" = $4
        AND NOT parent."id" = ANY(child."visited") AND child."depth" < 10
    ) SELECT "id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth" FROM chain ORDER BY "depth"`,
  [intent.taskId, intent.sessionId, intent.turnId, identity.rootTaskId])
  const chain = lineageResult.rows as TaskRow[]
  const root = { ...identity, status: identity.rootStatus }
  return validLineage(chain, intent.taskId, identity.rootTaskId) ? { target: identity, root, chain } : null
}
async function selectSubtree(client: Queryable, intent: TaskInterruptIntent, target: TaskRow): Promise<TaskRow[]> {
  const selected = await client.query(`WITH RECURSIVE subtree AS (
      SELECT task."id", task."parentTaskId", task."rootTaskId", task."turnId", task."path", task."depth", task."status", task."attemptCount", task."interruptRequestedAt"
      FROM "sub_agent_tasks" task WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
      UNION ALL SELECT child."id", child."parentTaskId", child."rootTaskId", child."turnId", child."path", child."depth", child."status", child."attemptCount", child."interruptRequestedAt"
      FROM "sub_agent_tasks" child JOIN subtree parent ON child."parentTaskId" = parent."id"
      WHERE child."sessionId" = $2 AND child."turnId" = $3 AND child."rootTaskId" = $4
    ) SELECT task."id", task."parentTaskId", task."rootTaskId", task."turnId", task."path", task."depth", task."status", task."attemptCount", task."interruptRequestedAt"
      FROM subtree JOIN "sub_agent_tasks" task USING ("id") ORDER BY task."depth", task."id" FOR UPDATE OF task`,
  [intent.taskId, intent.sessionId, intent.turnId, target.rootTaskId])
  return selected.rows as TaskRow[]
}

async function deleteDispatch(client: Queryable, sessionId: string, taskId: string): Promise<void> {
  await client.query(`DELETE FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1
    AND "idempotencyKey" = $2 AND "publishedAt" IS NULL`, [sessionId, `subagent-dispatch:${taskId}`])
}
async function applyIntent(client: Queryable, intent: TaskInterruptIntent, userId: string): Promise<{ rootTaskId: string; taskIds: string[] } | null> {
  const lineage = await resolveLineage(client, intent, userId)
  if (!lineage) { await rejectIntent(client, intent, userId); return null }
  const tasks = await selectSubtree(client, intent, lineage.target)
  const byId = new Map([...lineage.chain, ...tasks].map(task => [task.id, task] as const))
  for (const row of tasks) {
    const parent = row.parentTaskId ? byId.get(row.parentTaskId) : null
    if (!parent || row.depth !== parent.depth + 1 || row.path !== `${parent.path}/${row.id}` || row.rootTaskId !== lineage.target.rootTaskId) {
      await rejectIntent(client, intent, userId); return null
    }
  }
  const scope: GraphIdentityScope = { userId, sessionId: intent.sessionId, turnId: intent.turnId, rootTaskId: lineage.target.rootTaskId, parentTaskId: lineage.target.rootTaskId }
  const activeIds: string[] = []
  for (const row of tasks) {
    if (!ACTIVE.has(row.status) || row.interruptRequestedAt !== null) continue
    const running = row.status === "running"
    const graphMember = !running && row.parentTaskId === scope.rootTaskId && await hasPersistedTaskGraphMembership(client, scope, row.id)
    const graph = graphMember ? await prepareGraphTransition(client, { taskId: row.id, sessionId: intent.sessionId, type: "task.interrupted", attemptCount: Number(row.attemptCount) }) : null
    if (graphMember && (!graph || "blocked" in graph)) throw new Error("task_interrupt_graph_transition_unavailable")
    const updated = running
      ? await client.query(`UPDATE "sub_agent_tasks" SET "interruptRequestedAt" = COALESCE("interruptRequestedAt", clock_timestamp()), "updatedAt" = clock_timestamp()
          WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 AND "status" = 'running' AND "interruptRequestedAt" IS NULL`, [row.id, intent.sessionId, intent.turnId, scope.rootTaskId])
      : await client.query(`UPDATE "sub_agent_tasks" SET "interruptRequestedAt" = clock_timestamp(), "status" = 'interrupted', "leaseOwner" = NULL,
          "leaseExpiresAt" = NULL, "nextAttemptAt" = NULL, "completedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
          WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 AND "status" = $5 AND "interruptRequestedAt" IS NULL`, [row.id, intent.sessionId, intent.turnId, scope.rootTaskId, row.status])
    if (updated.rowCount !== 1) continue
    if (running) { activeIds.push(row.id); continue }
    await deleteDispatch(client, intent.sessionId, row.id)
    if (graph && !("blocked" in graph)) await persistGraphTransition(client, graph, new Date(), { stream: true })
    await appendOutcome(client, userId, intent, row.id, "interrupted")
  }
  return { rootTaskId: lineage.target.rootTaskId, taskIds: activeIds }
}

async function processRow(pool: PgSubagentPool, id: string, manager: AgentTreeManager): Promise<boolean> {
  try {
    const outcome = await transaction(pool, async client => {
      const result = await client.query<OutboxRow>(`SELECT "id", "aggregateId", "payload", "publishedAt" FROM "agent_outbox"
        WHERE "id" = $1 AND "topic" = $2 FOR UPDATE`, [id, TASK_INTERRUPT_OUTBOX_TOPIC])
      const row = result.rows[0]
      if (!row || row.publishedAt !== null) return { processed: false as const, signal: null }
      const intent = parseTaskInterruptIntent(row.payload)
      if (!intent || row.aggregateId !== intent.sessionId) throw new Error("task_interrupt_outbox_scope_invalid")
      const session = await client.query(`SELECT "id", "userId", "status" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE`, [intent.sessionId])
      const owner = session.rows[0] as Record<string, unknown> | undefined
      if (!owner || typeof owner.userId !== "string" || owner.status === "aborted" || owner.status === "archived") throw new Error("task_interrupt_session_unavailable")
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [owner.userId])
      const accepted = await client.query(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2
        AND "taskId" = $3 AND "type" = 'task.interrupt.accepted' AND "actor" = 'user'
        AND "payload"->>'intentId' = $4 FOR UPDATE`, [intent.sessionId, intent.turnId, intent.taskId, intent.intentId])
      const applied = accepted.rows[0] ? await applyIntent(client, intent, owner.userId)
        : (await rejectIntent(client, intent, owner.userId), null)
      await client.query(`UPDATE "agent_outbox" SET "publishedAt" = CURRENT_TIMESTAMP, "attemptCount" = "attemptCount" + 1, "lastError" = NULL
        WHERE "id" = $1 AND "topic" = $2 AND "publishedAt" IS NULL`, [id, TASK_INTERRUPT_OUTBOX_TOPIC])
      return { processed: true as const, signal: applied?.taskIds.length ? { sessionId: intent.sessionId, ...applied } : null }
    })
    if (outcome.signal?.rootTaskId) manager.signalTaskSubtree(outcome.signal.sessionId, outcome.signal.rootTaskId, outcome.signal.taskIds)
    return outcome.processed
  } catch {
    await transaction(pool, client => client.query(`UPDATE "agent_outbox" SET "attemptCount" = "attemptCount" + 1, "lastError" = 'processing_error'
      WHERE "id" = $1 AND "topic" = $2 AND "publishedAt" IS NULL`, [id, TASK_INTERRUPT_OUTBOX_TOPIC])).catch(() => undefined)
    return false
  }
}

async function reconcileCompleted(pool: PgSubagentPool): Promise<void> {
  await transaction(pool, async client => {
    const intents = await client.query(`SELECT command."payload" FROM "agent_outbox" command
      WHERE command."topic" = $1 AND command."publishedAt" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "agent_events" failed WHERE failed."sessionId" = command."aggregateId"
          AND failed."idempotencyKey" = 'agent-task-interrupt:' || (command."payload"->>'intentId') || ':' || (command."payload"->>'taskId') || ':failed')
        AND EXISTS (WITH RECURSIVE subtree AS (
          SELECT task."id", task."parentTaskId", task."rootTaskId", task."turnId", ARRAY[task."id"]::text[] AS "visited"
          FROM "sub_agent_tasks" task WHERE task."id" = command."payload"->>'taskId'
            AND task."sessionId" = command."aggregateId" AND task."turnId" = command."payload"->>'turnId'
          UNION ALL SELECT child."id", child."parentTaskId", child."rootTaskId", child."turnId", parent."visited" || child."id"
          FROM "sub_agent_tasks" child JOIN subtree parent ON child."parentTaskId" = parent."id"
          WHERE child."sessionId" = command."aggregateId" AND child."turnId" = command."payload"->>'turnId'
            AND child."rootTaskId" = parent."rootTaskId" AND NOT child."id" = ANY(parent."visited")
        ) SELECT 1 FROM subtree JOIN "sub_agent_tasks" task USING ("id")
          WHERE task."status" = 'interrupted' AND task."interruptRequestedAt" IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM "agent_events" event WHERE event."sessionId" = command."aggregateId"
              AND event."idempotencyKey" = 'agent-task-interrupt:' || (command."payload"->>'intentId') || ':' || task."id" || ':interrupted'))
      ORDER BY command."createdAt", command."id" LIMIT $2`, [TASK_INTERRUPT_OUTBOX_TOPIC, BATCH_SIZE])
    for (const raw of intents.rows) {
      const intent = parseTaskInterruptIntent((raw as Record<string, unknown>).payload)
      if (!intent) continue
      const session = await client.query(`SELECT "userId" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE`, [intent.sessionId])
      const userId = session.rows[0]?.userId
      if (typeof userId !== "string") continue
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId])
      const failed = await client.query(`SELECT 1 FROM "agent_events" WHERE "sessionId" = $1 AND "idempotencyKey" = $2`, [intent.sessionId, key(intent, intent.taskId, "failed")])
      if (failed.rows.length) continue
      const terminal = await client.query(`WITH RECURSIVE subtree AS (
          SELECT task."id", task."parentTaskId", task."rootTaskId", task."turnId" FROM "sub_agent_tasks" task
          WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3
          UNION ALL SELECT child."id", child."parentTaskId", child."rootTaskId", child."turnId" FROM "sub_agent_tasks" child JOIN subtree parent ON child."parentTaskId" = parent."id"
          WHERE child."sessionId" = $2 AND child."turnId" = $3 AND child."rootTaskId" = parent."rootTaskId"
        ) SELECT task."id" FROM subtree JOIN "sub_agent_tasks" task USING ("id")
          WHERE task."status" = 'interrupted' AND task."interruptRequestedAt" IS NOT NULL`, [intent.taskId, intent.sessionId, intent.turnId])
      for (const task of terminal.rows) await appendOutcome(client, userId, intent, String(task.id), "interrupted")
    }
  })
}

export async function drainTaskInterruptOutbox(pool: PgSubagentPool, manager: AgentTreeManager): Promise<number> {
  const rows = await transaction(pool, client => client.query<{ id: string }>(`SELECT "id" FROM "agent_outbox"
    WHERE "topic" = $1 AND "publishedAt" IS NULL ORDER BY "createdAt", "id" LIMIT $2 FOR UPDATE SKIP LOCKED`, [TASK_INTERRUPT_OUTBOX_TOPIC, BATCH_SIZE]))
  let processed = 0
  for (const row of rows.rows) if (await processRow(pool, row.id, manager)) processed++
  await reconcileCompleted(pool)
  return processed
}

export function startTaskInterruptOutboxConsumer(pool: PgSubagentPool, manager: AgentTreeManager, options: StartOptions = {}) {
  const pollMs = options.pollMs ?? Number(process.env.AGENT_TASK_INTERRUPT_OUTBOX_POLL_MS ?? POLL_MS)
  let closed = false
  let inFlight: Promise<void> | null = null
  const run = () => {
    if (closed || inFlight) return
    const current = (options.drain ? options.drain(pool, manager) : drainTaskInterruptOutbox(pool, manager))
      .then(() => options.drain ? reconcileCompleted(pool) : undefined).catch(error => { console.error("[agent-task-interrupt-outbox] drain failed:", error) })
      .finally(() => { if (inFlight === current) inFlight = null })
    inFlight = current
  }
  const timer = setInterval(run, Number.isFinite(pollMs) && pollMs >= 250 && pollMs <= 30_000 ? pollMs : POLL_MS)
  timer.unref?.()
  run()
  return { async close() { closed = true; clearInterval(timer); await inFlight } }
}
