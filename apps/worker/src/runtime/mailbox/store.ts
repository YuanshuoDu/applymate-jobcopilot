import { randomUUID } from "node:crypto"
import type pg from "pg"

import type {
  CoordinationActivity,
  CoordinationMailboxConsumeResult,
  CoordinationMailboxMessage,
  CoordinationMailboxOwnerFence,
  CoordinationMessage,
  CoordinationStore,
  CoordinationTaskView,
} from "../tools/coordination-types.js"
import { CoordinationError } from "../tools/coordination-types.js"

type PoolLike = Pick<pg.Pool, "connect">
type Queryable = Pick<pg.PoolClient, "query">

const TASK_COLUMNS = `task."id", session."userId" AS "userId", task."sessionId", task."turnId", task."rootTaskId",
  task."parentTaskId", task."path", task."depth", task."role", task."taskType", task."status", task."goal",
  task."attemptCount", task."maxAttempts", task."leaseOwner", task."leaseExpiresAt", task."interruptRequestedAt"`
const TERMINAL = ["completed", "failed", "interrupted", "cancelled", "closed"]
const DEFAULT_MAILBOX_READ_LIMIT = 50
const MAX_MAILBOX_READ_LIMIT = 100

export class PgCoordinationStore implements CoordinationStore {
  constructor(private readonly pool: PoolLike) {}

  async getTask(input: { userId: string; sessionId: string; taskId: string }): Promise<CoordinationTaskView | null> {
    const client = await this.pool.connect()
    try {
      await setUser(client, input.userId)
      const result = await client.query(`SELECT ${TASK_COLUMNS} FROM "sub_agent_tasks" task
        JOIN "agent_sessions" session ON session."id" = task."sessionId"
        WHERE task."id" = $1 AND task."sessionId" = $2 AND session."userId" = $3`, [input.taskId, input.sessionId, input.userId])
      return result.rows[0] ? taskRow(result.rows[0] as Record<string, unknown>) : null
    } finally { client.release() }
  }

  async listTasks(input: { userId: string; sessionId: string; rootTaskId?: string; includeTerminal: boolean }): Promise<CoordinationTaskView[]> {
    const client = await this.pool.connect()
    try {
      await setUser(client, input.userId)
      const params: unknown[] = [input.sessionId, input.userId]
      const filters = [`task."sessionId" = $1`, `session."userId" = $2`]
      if (input.rootTaskId) { params.push(input.rootTaskId); filters.push(`task."rootTaskId" = $${params.length}`) }
      if (!input.includeTerminal) { params.push(TERMINAL); filters.push(`NOT (task."status" = ANY($${params.length}::text[]))`) }
      const result = await client.query(`SELECT ${TASK_COLUMNS} FROM "sub_agent_tasks" task
        JOIN "agent_sessions" session ON session."id" = task."sessionId" WHERE ${filters.join(" AND ")}
        ORDER BY task."path" ASC, task."createdAt" ASC, task."id" ASC LIMIT 50`, params)
      return result.rows.map(row => taskRow(row as Record<string, unknown>))
    } finally { client.release() }
  }

  async listPendingMessages(input: { userId: string; sessionId: string; toTaskId: string; limit?: number }): Promise<CoordinationMailboxMessage[]> {
    const limit = mailboxReadLimit(input.limit)
    return transaction(this.pool, input.userId, async client => {
      await requireSession(client, input)
      await requireTask(client, input.userId, input.sessionId, input.toTaskId, "Target task is unavailable")
      const result = await client.query(`SELECT message."id", message."sessionId", message."turnId", message."fromTaskId", message."toTaskId",
        message."kind", message."payload", message."idempotencyKey", message."createdAt", message."deliveredAt", message."consumedAt"
        FROM "agent_mailbox_messages" AS message
        JOIN "agent_sessions" AS session ON session."id" = message."sessionId"
        JOIN "sub_agent_tasks" AS target ON target."id" = message."toTaskId" AND target."sessionId" = message."sessionId"
        WHERE message."sessionId" = $1 AND session."userId" = $2 AND message."toTaskId" = $3
          AND target."id" = $3 AND target."sessionId" = $1 AND message."turnId" = target."turnId"
          AND message."consumedAt" IS NULL
        ORDER BY message."createdAt" ASC, message."id" ASC LIMIT $4`,
      [input.sessionId, input.userId, input.toTaskId, limit])
      return result.rows.map(row => mailboxMessageRow(row as Record<string, unknown>))
    })
  }

  async consumeMessages(input: { userId: string; sessionId: string; toTaskId: string; messageIds: readonly string[]; owner: CoordinationMailboxOwnerFence }): Promise<CoordinationMailboxConsumeResult> {
    const owner = mailboxOwnerFence(input.owner)
    const messageIds = uniqueMessageIds(input.messageIds)
    return transaction(this.pool, input.userId, async client => {
      await requireSession(client, input)
      await requireMailboxOwner(client, input, owner)
      if (messageIds.length === 0) return { messageIds: [], count: 0 }
      const result = await client.query(`UPDATE "agent_mailbox_messages" AS message
        SET "consumedAt" = CURRENT_TIMESTAMP
        WHERE message."sessionId" = $1 AND message."toTaskId" = $3 AND message."id" = ANY($4::text[])
          AND message."consumedAt" IS NULL
          AND EXISTS (SELECT 1 FROM "agent_sessions" AS session
            WHERE session."id" = message."sessionId" AND session."userId" = $2
              AND session."status" NOT IN ('aborted', 'archived'))
          AND EXISTS (SELECT 1 FROM "sub_agent_tasks" AS target
            WHERE target."id" = message."toTaskId" AND target."sessionId" = message."sessionId"
              AND target."id" = $3 AND target."sessionId" = $1 AND target."status" = 'running'
              AND target."leaseOwner" = $5 AND target."attemptCount" = $6
              AND target."interruptRequestedAt" IS NULL AND target."leaseExpiresAt" > $7)
        RETURNING message."id"`, [input.sessionId, input.userId, input.toTaskId, messageIds, owner.ownerId, owner.attemptCount, owner.now])
      const consumedIds = result.rows.map(row => String(row.id))
      return { messageIds: orderMessageIds(messageIds, consumedIds), count: consumedIds.length }
    })
  }

  async sendMessage(input: {
    userId: string; sessionId: string; turnId: string; fromTaskId: string | null; toTaskId: string; kind: string; payload: unknown; idempotencyKey: string
  }): Promise<{ message: CoordinationMessage; duplicate: boolean }> {
    return transaction(this.pool, input.userId, async client => {
      await requireSession(client, input)
      await requireTurn(client, input)
      await requireTask(client, input.userId, input.sessionId, input.toTaskId, "Target task is unavailable", input.turnId)
      if (input.fromTaskId) await requireTask(client, input.userId, input.sessionId, input.fromTaskId, "Sender task is unavailable", input.turnId)
      const existing = await client.query(`SELECT "id", "sessionId", "turnId", "fromTaskId", "toTaskId", "kind", "payload", "idempotencyKey", "createdAt"
        FROM "agent_mailbox_messages" WHERE "sessionId" = $1 AND "idempotencyKey" = $2`, [input.sessionId, input.idempotencyKey])
      if (existing.rows[0]) {
        const row = existing.rows[0] as Record<string, unknown>
        if (String(row.toTaskId) !== input.toTaskId || String(row.kind) !== input.kind || stableJson(row.payload) !== stableJson(input.payload)) {
          throw new CoordinationError("coordination_idempotency_conflict", "Mailbox idempotency key was reused with different content")
        }
        return { message: messageRow(row), duplicate: true }
      }
      const id = `mailbox-${randomUUID()}`
      const inserted = await client.query(`INSERT INTO "agent_mailbox_messages"
        ("id", "sessionId", "turnId", "fromTaskId", "toTaskId", "kind", "payload", "idempotencyKey")
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING "id", "sessionId", "turnId", "fromTaskId", "toTaskId", "kind", "idempotencyKey", "createdAt"`,
      [id, input.sessionId, input.turnId, input.fromTaskId, input.toTaskId, input.kind, json(input.payload), input.idempotencyKey])
      if (!inserted.rows[0]) throw new CoordinationError("coordination_write_failed", "Mailbox message was not persisted")
      const message = messageRow({
        ...inserted.rows[0], sessionId: input.sessionId, turnId: input.turnId, fromTaskId: input.fromTaskId,
        toTaskId: input.toTaskId, kind: input.kind, idempotencyKey: input.idempotencyKey, payload: input.payload,
      })
      await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
        VALUES ($1, 'agent.subagent.mailbox', $2, $3, $4::jsonb) ON CONFLICT ("idempotencyKey") DO NOTHING`,
      [`mailbox-outbox-${id}`, input.sessionId, `agent-mailbox:${input.sessionId}:${id}`, json({ messageId: id, sessionId: input.sessionId, turnId: input.turnId, toTaskId: input.toTaskId })])
      return { message, duplicate: false }
    })
  }

  async getSpawnReplay(input: { userId: string; sessionId: string; idempotencyKey: string }): Promise<CoordinationTaskView | null> {
    const client = await this.pool.connect()
    try {
      await setUser(client, input.userId)
      const result = await client.query(`SELECT "payload" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.spawn'
        AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [input.sessionId, spawnKey(input.sessionId, input.idempotencyKey)])
      const payload = result.rows[0]?.payload as Record<string, unknown> | undefined
      const taskId = payload && typeof payload.taskId === "string" ? payload.taskId : null
      return taskId ? this.getTask({ ...input, taskId }) : null
    } finally { client.release() }
  }

  async recordSpawn(input: { userId: string; sessionId: string; idempotencyKey: string; task: CoordinationTaskView }): Promise<boolean> {
    return transaction(this.pool, input.userId, async client => {
      await requireSession(client, input)
      await requireTask(client, input.userId, input.sessionId, input.task.id, "Subagent task is unavailable")
      const operation = await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
        VALUES ($1, 'agent.subagent.spawn', $2, $3, $4::jsonb) ON CONFLICT ("idempotencyKey") DO NOTHING`,
      [`spawn-operation-${randomUUID()}`, input.sessionId, spawnKey(input.sessionId, input.idempotencyKey), json({ taskId: input.task.id })])
      if (operation.rowCount !== 1) return false
      await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
        VALUES ($1, 'agent.subagent.dispatch', $2, $3, $4::jsonb) ON CONFLICT ("idempotencyKey") DO NOTHING`,
      [`subagent-dispatch-${randomUUID()}`, input.sessionId, `subagent-dispatch:${input.task.id}`, json({ taskId: input.task.id, sessionId: input.task.sessionId, rootTaskId: input.task.rootTaskId, ownerId: `coordination-${randomUUID()}` })])
      return true
    })
  }

  async appendActivity(input: CoordinationActivity): Promise<void> {
    await transaction(this.pool, input.userId, async client => {
      await requireSession(client, input)
      const key = `coordination-activity:${input.sessionId}:${input.idempotencyKey}`
      const existing = await client.query(`SELECT 1 FROM "agent_events" WHERE "sessionId" = $1 AND "idempotencyKey" = $2`, [input.sessionId, key])
      if (existing.rows[0]) return
      const itemId = `activity-${randomUUID()}`
      await client.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "content", "completedAt")
        VALUES ($1, $2, $3, $4, $5, 'subagent_activity', $6, 'commentary', $7::jsonb, CURRENT_TIMESTAMP)`,
      [itemId, input.sessionId, input.turnId, input.stepId, input.taskId, input.status === "completed" ? "completed" : input.status === "failed" ? "failed" : "started", json({ operation: input.operation, data: input.data })])
      const sequence = await client.query<{ eventSequence: string | bigint }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1 WHERE "id" = $1 AND "userId" = $2 RETURNING "eventSequence"`, [input.sessionId, input.userId])
      if (!sequence.rows[0]) throw new CoordinationError("coordination_scope_error", "Session is unavailable")
      const eventId = `activity-event-${randomUUID()}`
      await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload")
        VALUES ($1, $2, $3, $4, $5, $6, 'item.completed', 'tool', $3, $7, $8::jsonb)`,
      [eventId, input.sessionId, input.turnId, itemId, input.taskId, String(sequence.rows[0].eventSequence), key, json({ type: "subagent_activity", operation: input.operation, status: input.status })])
      await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload") VALUES ($1, 'agent.session.event', $2, $3, $4::jsonb) ON CONFLICT ("idempotencyKey") DO NOTHING`,
      [`activity-outbox-${eventId}`, input.sessionId, `agent-event:${eventId}`, json({ eventId, sessionId: input.sessionId, turnId: input.turnId, itemId, taskId: input.taskId, type: "item.completed" })])
    })
  }
}

async function transaction<T>(pool: PoolLike, userId: string, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try { await client.query("BEGIN"); await setUser(client, userId); const value = await work(client); await client.query("COMMIT"); return value }
  catch (error: unknown) { await client.query("ROLLBACK").catch(() => undefined); throw error }
  finally { client.release() }
}

async function setUser(client: Queryable, userId: string): Promise<void> { await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId]) }
async function requireSession(client: Queryable, input: { userId: string; sessionId: string }): Promise<void> {
  const result = await client.query(`SELECT 1 FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2
    AND "status" NOT IN ('aborted', 'archived') FOR UPDATE`, [input.sessionId, input.userId])
  if (!result.rows[0]) throw new CoordinationError("coordination_scope_error", "Session is unavailable")
}
async function requireTurn(client: Queryable, input: { userId: string; sessionId: string; turnId: string }): Promise<void> {
  const result = await client.query(`SELECT 1 FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`, [input.turnId, input.sessionId, input.userId])
  if (!result.rows[0]) throw new CoordinationError("coordination_scope_error", "Turn is unavailable")
}
async function requireTask(client: Queryable, userId: string, sessionId: string, taskId: string, message: string, turnId?: string): Promise<void> {
  const turnPredicate = turnId === undefined ? "" : ` AND task."turnId" = $4`
  const values: unknown[] = [taskId, sessionId, userId]
  if (turnId !== undefined) values.push(turnId)
  const result = await client.query(`SELECT 1 FROM "sub_agent_tasks" task JOIN "agent_sessions" session ON session."id" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND session."userId" = $3${turnPredicate}`, values)
  if (!result.rows[0]) throw new CoordinationError("coordination_task_not_found", message)
}
function taskRow(row: Record<string, unknown>): CoordinationTaskView {
  return { id: String(row.id), userId: String(row.userId), sessionId: String(row.sessionId), turnId: row.turnId ? String(row.turnId) : null, rootTaskId: String(row.rootTaskId ?? row.id), parentTaskId: row.parentTaskId ? String(row.parentTaskId) : null, path: String(row.path), depth: Number(row.depth), role: String(row.role), taskType: String(row.taskType), status: String(row.status) as CoordinationTaskView["status"], goal: String(row.goal), attemptCount: Number(row.attemptCount), maxAttempts: Number(row.maxAttempts), leaseOwner: row.leaseOwner ? String(row.leaseOwner) : null, leaseExpiresAt: row.leaseExpiresAt instanceof Date ? row.leaseExpiresAt : row.leaseExpiresAt ? new Date(String(row.leaseExpiresAt)) : null, interruptRequestedAt: row.interruptRequestedAt instanceof Date ? row.interruptRequestedAt : row.interruptRequestedAt ? new Date(String(row.interruptRequestedAt)) : null }
}
async function requireMailboxOwner(client: Queryable, input: { userId: string; sessionId: string; toTaskId: string }, owner: CoordinationMailboxOwnerFence): Promise<void> {
  const result = await client.query(`SELECT target."id"
    FROM "sub_agent_tasks" AS target
    JOIN "agent_sessions" AS session ON session."id" = target."sessionId"
    WHERE target."id" = $1 AND target."sessionId" = $2 AND session."userId" = $3
      AND target."status" = 'running' AND target."leaseOwner" = $4 AND target."attemptCount" = $5
      AND target."interruptRequestedAt" IS NULL AND target."leaseExpiresAt" > $6
    FOR UPDATE`, [input.toTaskId, input.sessionId, input.userId, owner.ownerId, owner.attemptCount, owner.now])
  if (!result.rows[0]) throw new CoordinationError("coordination_mailbox_owner_conflict", "Mailbox target task is not owned by the active lease")
}
function messageRow(row: Record<string, unknown>): CoordinationMessage { return { id: String(row.id), sessionId: String(row.sessionId), turnId: String(row.turnId), fromTaskId: row.fromTaskId ? String(row.fromTaskId) : null, toTaskId: String(row.toTaskId), kind: String(row.kind), idempotencyKey: String(row.idempotencyKey), createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(String(row.createdAt)) } }
function mailboxMessageRow(row: Record<string, unknown>): CoordinationMailboxMessage {
  return { ...messageRow(row), payload: row.payload, deliveredAt: nullableDate(row.deliveredAt), consumedAt: nullableDate(row.consumedAt) }
}
function nullableDate(value: unknown): Date | null { return value == null ? null : value instanceof Date ? value : new Date(String(value)) }
function mailboxReadLimit(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) return DEFAULT_MAILBOX_READ_LIMIT
  return Math.min(MAX_MAILBOX_READ_LIMIT, Math.max(0, Math.floor(value)))
}
function uniqueMessageIds(ids: readonly string[]): string[] { return [...new Set(ids.filter(id => typeof id === "string" && id.length > 0))] }
function orderMessageIds(requested: readonly string[], confirmed: readonly string[]): string[] {
  const confirmedSet = new Set(confirmed)
  return requested.filter(id => confirmedSet.has(id))
}
function mailboxOwnerFence(value: unknown): CoordinationMailboxOwnerFence {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CoordinationError("coordination_invalid_input", "Mailbox owner fence is invalid")
  const row = value as Record<string, unknown>
  const ownerId = row.ownerId
  const attemptCount = row.attemptCount
  const now = row.now
  if (typeof ownerId !== "string" || ownerId.trim().length === 0) throw new CoordinationError("coordination_invalid_input", "Mailbox owner fence ownerId is invalid")
  if (!Number.isSafeInteger(attemptCount) || Number(attemptCount) < 1) throw new CoordinationError("coordination_invalid_input", "Mailbox owner fence attemptCount is invalid")
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new CoordinationError("coordination_invalid_input", "Mailbox owner fence now is invalid")
  return { ownerId, attemptCount: Number(attemptCount), now }
}
function json(value: unknown): string { return JSON.stringify(value ?? null) }
function stableJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`; return JSON.stringify(value) ?? "null" }
function spawnKey(sessionId: string, key: string): string { return `coordination-spawn:${sessionId}:${key}` }
