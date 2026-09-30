import { createHash } from "node:crypto"
import type pg from "pg"

import type { CoordinationMailboxMessage } from "../tools/coordination-types.js"
import { CoordinationError } from "../tools/coordination-types.js"

type PoolLike = Pick<pg.Pool, "connect">
type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>

export type ChildMailboxHydrationInput = {
  readonly userId: string
  readonly sessionId: string
  readonly turnId: string
  readonly rootTaskId: string
  readonly toTaskId: string
  readonly ownerId: string
  readonly attemptCount: number
  readonly stepId: string
  readonly limit: number
}

const TERMINAL_TASK = `'completed', 'failed', 'interrupted', 'cancelled', 'closed'`
const TERMINAL_TURN = `'completed', 'failed', 'interrupted', 'cancelled'`
const TERMINAL_STEP = `'completed', 'failed', 'interrupted'`

/** Hydrates a child mailbox from durable checkpoints under one owner-fenced transaction. */
export async function hydrateChildMailbox(pool: PoolLike, rawInput: ChildMailboxHydrationInput): Promise<CoordinationMailboxMessage[]> {
  const input = normalizeInput(rawInput)
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await setUser(client, input.userId)
    await requireSession(client, input)
    await requireTarget(client, input)
    await requireRoot(client, input)
    await requireTurn(client, input)
    await requireStep(client, input)
    await lockCheckpoints(client, input)

    const existing = await readHydrated(client, input)
    const available = input.limit - existing.length
    if (available > 0) {
      const pending = await readUncheckpointed(client, input, available)
      for (const row of pending) await insertCheckpoint(client, input, row)
    }
    const result = await readHydrated(client, input)
    await client.query("COMMIT")
    return result
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function setUser(client: Queryable, userId: string): Promise<void> {
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId])
}

async function requireSession(client: Queryable, input: ChildMailboxHydrationInput): Promise<void> {
  const result = await client.query(`SELECT session."id", session."userId", session."status"
    FROM "agent_sessions" AS session
    WHERE session."id" = $1 AND session."userId" = $2
      AND session."status" NOT IN ('aborted', 'archived', 'closed', 'completed', 'failed', 'cancelled')
    FOR UPDATE OF session`, [input.sessionId, input.userId])
  if (!result.rows[0]) throw new CoordinationError("coordination_scope_error", "Session is unavailable")
}

async function requireTarget(client: Queryable, input: ChildMailboxHydrationInput): Promise<void> {
  const result = await client.query(`SELECT target."id", target."sessionId", target."turnId", target."rootTaskId",
      target."status", target."leaseOwner", target."attemptCount", target."leaseExpiresAt", target."interruptRequestedAt"
    FROM "sub_agent_tasks" AS target
    JOIN "agent_sessions" AS session ON session."id" = target."sessionId"
    WHERE target."id" = $1 AND target."sessionId" = $2 AND session."userId" = $3
      AND target."turnId" = $4 AND target."rootTaskId" = $5
      AND target."status" = 'running' AND target."leaseOwner" = $6
      AND target."attemptCount" = $7 AND target."interruptRequestedAt" IS NULL
      AND target."leaseExpiresAt" > CURRENT_TIMESTAMP
    FOR UPDATE OF target`, [input.toTaskId, input.sessionId, input.userId, input.turnId, input.rootTaskId, input.ownerId, input.attemptCount])
  if (!result.rows[0]) throw new CoordinationError("coordination_mailbox_owner_conflict", "Mailbox target task is not owned by the active lease")
}

async function requireRoot(client: Queryable, input: ChildMailboxHydrationInput): Promise<void> {
  const result = await client.query(`SELECT root."id", root."sessionId", root."turnId", root."rootTaskId", root."status"
    FROM "sub_agent_tasks" AS root
    JOIN "agent_sessions" AS session ON session."id" = root."sessionId"
    WHERE root."id" = $1 AND root."sessionId" = $2 AND root."rootTaskId" = $1
      AND root."turnId" = $3 AND session."userId" = $4
      AND root."status" NOT IN (${TERMINAL_TASK})
    FOR UPDATE OF root`, [input.rootTaskId, input.sessionId, input.turnId, input.userId])
  if (!result.rows[0]) throw new CoordinationError("coordination_scope_error", "Root task lineage is unavailable")
}

async function requireTurn(client: Queryable, input: ChildMailboxHydrationInput): Promise<void> {
  const result = await client.query(`SELECT turn."id", turn."sessionId", turn."userId", turn."rootTaskId", turn."status"
    FROM "agent_turns" AS turn
    JOIN "agent_sessions" AS session ON session."id" = turn."sessionId"
    WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3
      AND turn."rootTaskId" = $4 AND turn."status" NOT IN (${TERMINAL_TURN})
    FOR UPDATE OF turn`, [input.turnId, input.sessionId, input.userId, input.rootTaskId])
  if (!result.rows[0]) throw new CoordinationError("coordination_scope_error", "Turn lineage is unavailable")
}

async function requireStep(client: Queryable, input: ChildMailboxHydrationInput): Promise<void> {
  const result = await client.query(`SELECT step."id", step."taskId", step."turnId", step."sessionId", step."attempt", step."status"
    FROM "agent_steps" AS step
    WHERE step."id" = $1 AND step."turnId" = $2 AND step."sessionId" = $3
      AND step."taskId" = $4 AND step."attempt" = $5
      AND step."status" NOT IN (${TERMINAL_STEP})
    FOR UPDATE OF step`, [input.stepId, input.turnId, input.sessionId, input.toTaskId, input.attemptCount])
  if (!result.rows[0]) throw new CoordinationError("coordination_scope_error", "Step lineage is unavailable")
}

async function lockCheckpoints(client: Queryable, input: ChildMailboxHydrationInput): Promise<void> {
  await client.query(`SELECT checkpoint."id"
    FROM "agent_mailbox_hydration_checkpoints" AS checkpoint
    WHERE checkpoint."userId" = $1 AND checkpoint."sessionId" = $2
      AND checkpoint."turnId" = $3 AND checkpoint."rootTaskId" = $4
      AND checkpoint."taskId" = $5 AND checkpoint."attempt" = $6
    ORDER BY checkpoint."createdAt" ASC, checkpoint."id" ASC
    FOR UPDATE OF checkpoint`, checkpointValues(input))
}

async function readHydrated(client: Queryable, input: ChildMailboxHydrationInput): Promise<CoordinationMailboxMessage[]> {
  const result = await client.query(`SELECT message."id", message."sessionId", message."turnId", message."fromTaskId", message."toTaskId",
      message."kind", message."payload", message."idempotencyKey", message."createdAt", message."deliveredAt", message."consumedAt"
    FROM "agent_mailbox_hydration_checkpoints" AS checkpoint
    JOIN "agent_mailbox_messages" AS message
      ON message."id" = checkpoint."messageId" AND message."sessionId" = checkpoint."sessionId"
    JOIN "sub_agent_tasks" AS target
      ON target."id" = message."toTaskId" AND target."sessionId" = message."sessionId"
    JOIN "agent_sessions" AS session ON session."id" = message."sessionId"
    WHERE checkpoint."userId" = $1 AND checkpoint."sessionId" = $2
      AND checkpoint."turnId" = $3 AND checkpoint."rootTaskId" = $4
      AND checkpoint."taskId" = $5 AND checkpoint."attempt" = $6
      AND message."sessionId" = $2 AND message."turnId" = $3 AND message."toTaskId" = $5
      AND target."sessionId" = $2 AND target."turnId" = $3 AND target."rootTaskId" = $4
      AND session."userId" = $1 AND message."consumedAt" IS NULL
    ORDER BY message."createdAt" ASC, message."id" ASC
    LIMIT $7
    FOR UPDATE OF message`, values(input, input.limit))
  return result.rows.map(row => mailboxMessageRow(row as Row))
}

async function readUncheckpointed(client: Queryable, input: ChildMailboxHydrationInput, limit: number): Promise<Row[]> {
  const result = await client.query(`SELECT message."id", message."sessionId", message."turnId", message."fromTaskId", message."toTaskId",
      message."kind", message."payload", message."idempotencyKey", message."createdAt", message."deliveredAt", message."consumedAt"
    FROM "agent_mailbox_messages" AS message
    JOIN "agent_sessions" AS session ON session."id" = message."sessionId"
    JOIN "sub_agent_tasks" AS target
      ON target."id" = message."toTaskId" AND target."sessionId" = message."sessionId"
    LEFT JOIN "agent_mailbox_hydration_checkpoints" AS checkpoint
      ON checkpoint."messageId" = message."id" AND checkpoint."sessionId" = message."sessionId"
      AND checkpoint."turnId" = $3 AND checkpoint."rootTaskId" = $4
      AND checkpoint."taskId" = $5 AND checkpoint."attempt" = $7
    WHERE message."sessionId" = $2 AND session."userId" = $1
      AND message."turnId" = $3 AND message."toTaskId" = $5
      AND target."sessionId" = $2 AND target."turnId" = $3 AND target."rootTaskId" = $4
      AND target."status" = 'running' AND target."leaseOwner" = $6
      AND target."attemptCount" = $7 AND target."interruptRequestedAt" IS NULL
      AND target."leaseExpiresAt" > CURRENT_TIMESTAMP
      AND message."consumedAt" IS NULL AND checkpoint."id" IS NULL
    ORDER BY message."createdAt" ASC, message."id" ASC
    LIMIT $8
    FOR UPDATE OF message`, [input.userId, input.sessionId, input.turnId, input.rootTaskId, input.toTaskId, input.ownerId, input.attemptCount, limit])
  return result.rows as Row[]
}

async function insertCheckpoint(client: Queryable, input: ChildMailboxHydrationInput, row: Row): Promise<void> {
  const messageId = textValue(row.id, "message id")
  await client.query(`INSERT INTO "agent_mailbox_hydration_checkpoints"
    ("id", "userId", "sessionId", "turnId", "rootTaskId", "taskId", "attempt", "stepId", "messageId")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT ("sessionId", "taskId", "attempt", "messageId") DO NOTHING`,
  [checkpointId(input, messageId), input.userId, input.sessionId, input.turnId, input.rootTaskId, input.toTaskId, input.attemptCount, input.stepId, messageId])
}

function values(input: ChildMailboxHydrationInput, limit = input.limit): unknown[] {
  return [input.userId, input.sessionId, input.turnId, input.rootTaskId, input.toTaskId, input.attemptCount, limit]
}

function checkpointValues(input: ChildMailboxHydrationInput): unknown[] {
  return [input.userId, input.sessionId, input.turnId, input.rootTaskId, input.toTaskId, input.attemptCount]
}

function checkpointId(input: ChildMailboxHydrationInput, messageId: string): string {
  const identity = [input.sessionId, input.toTaskId, String(input.attemptCount), messageId].join("\u0000")
  return `hydration-${createHash("sha256").update(identity).digest("hex")}`
}

function mailboxMessageRow(row: Row): CoordinationMailboxMessage {
  return {
    id: textValue(row.id, "message id"), sessionId: textValue(row.sessionId, "message sessionId"), turnId: textValue(row.turnId, "message turnId"),
    fromTaskId: row.fromTaskId == null ? null : textValue(row.fromTaskId, "message fromTaskId"), toTaskId: textValue(row.toTaskId, "message toTaskId"),
    kind: textValue(row.kind, "message kind"), payload: row.payload, idempotencyKey: textValue(row.idempotencyKey, "message idempotencyKey"),
    createdAt: dateValue(row.createdAt, "message createdAt"), deliveredAt: nullableDate(row.deliveredAt), consumedAt: nullableDate(row.consumedAt),
  }
}

function normalizeInput(value: ChildMailboxHydrationInput): ChildMailboxHydrationInput {
  if (!value || typeof value !== "object") throw new CoordinationError("coordination_invalid_input", "Hydration input is invalid")
  const row = value as unknown as Row
  return {
    userId: requiredText(row.userId, "userId"), sessionId: requiredText(row.sessionId, "sessionId"), turnId: requiredText(row.turnId, "turnId"),
    rootTaskId: requiredText(row.rootTaskId, "rootTaskId"), toTaskId: requiredText(row.toTaskId, "toTaskId"), ownerId: requiredText(row.ownerId, "ownerId"),
    attemptCount: positiveInt(row.attemptCount, "attemptCount"), stepId: requiredText(row.stepId, "stepId"), limit: boundedLimit(row.limit),
  }
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) throw new CoordinationError("coordination_invalid_input", `${name} is required`)
  return value
}
function positiveInt(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 2_147_483_647) throw new CoordinationError("coordination_invalid_input", `${name} must be a positive safe integer`)
  return Number(value)
}
function boundedLimit(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 20) throw new CoordinationError("coordination_invalid_input", "limit must be a safe integer between 0 and 20")
  return Number(value)
}
function textValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new CoordinationError("coordination_scope_error", `${name} is invalid`)
  return value
}
function dateValue(value: unknown, name: string): Date {
  const date = value instanceof Date ? value : new Date(String(value))
  if (!Number.isFinite(date.getTime())) throw new CoordinationError("coordination_scope_error", `${name} is invalid`)
  return date
}
function nullableDate(value: unknown): Date | null { return value == null ? null : dateValue(value, "mailbox timestamp") }
