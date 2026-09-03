import type pg from "pg"

import {
  assertInterruptTarget,
  interruptReason,
  interruptTargetKey,
  type InterruptPersistencePort,
  type InterruptRequestInput,
  type InterruptTarget,
  type PersistedInterruptRequest,
} from "./types.js"

export type InterruptPersistenceClient = Pick<pg.PoolClient, "query" | "release">
export type InterruptPersistencePool = Pick<pg.Pool, "connect">

export type InterruptPersistenceErrorCode = "turn_not_found" | "turn_not_active" | "persistence_conflict"

export class InterruptPersistenceError extends Error {
  constructor(readonly code: InterruptPersistenceErrorCode, message: string) {
    super(message)
    this.name = "InterruptPersistenceError"
  }
}

const ACTIVE_TURN_STATUSES = [
  "queued",
  "in_progress",
  "waiting_for_dependency",
  "waiting_for_approval",
  "waiting_for_user",
] as const

function requestKey(input: InterruptRequestInput): string {
  return `agent-interrupt:${input.sessionId}:${input.turnId}:${input.requestId}`
}

function validateInput(input: InterruptRequestInput): void {
  assertInterruptTarget(input)
  if (input.requestId.trim().length === 0) throw new TypeError("Interrupt requestId must be a non-empty string")
  if (input.requestedAt && Number.isNaN(input.requestedAt.getTime())) throw new TypeError("Interrupt requestedAt must be a valid Date")
}

export class InMemoryInterruptPersistence implements InterruptPersistencePort {
  private readonly requests = new Map<string, PersistedInterruptRequest>()

  async persist(input: InterruptRequestInput): Promise<PersistedInterruptRequest> {
    validateInput(input)
    const targetKey = interruptTargetKey(input)
    const existing = this.requests.get(targetKey)
    if (existing) return { ...input, reason: interruptReason(input.reason), persistedAt: existing.persistedAt, disposition: "duplicate" }
    const persistedAt = input.requestedAt ?? new Date()
    const request = { ...input, reason: interruptReason(input.reason), persistedAt, disposition: "accepted" as const }
    this.requests.set(targetKey, request)
    return request
  }

  async isRequested(target: InterruptTarget): Promise<boolean> {
    assertInterruptTarget(target)
    return this.requests.has(interruptTargetKey(target))
  }
}

/** Durable adapter over the existing AgentTurn/AgentEvent control-plane facts. */
export function createPgInterruptPersistence(pool: InterruptPersistencePool, now: () => Date = () => new Date()): InterruptPersistencePort {
  return {
    persist: (input) => persistInterrupt(pool, input, now),
    isRequested: (target) => readInterrupt(pool, target),
  }
}

async function persistInterrupt(pool: InterruptPersistencePool, input: InterruptRequestInput, now: () => Date): Promise<PersistedInterruptRequest> {
  validateInput(input)
  const timestamp = input.requestedAt ?? now()
  const key = requestKey(input)
  const client = await pool.connect()
  let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", input.userId])
    const turn = await client.query<{ status: string }>(
      `SELECT "status" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 FOR UPDATE`,
      [input.turnId, input.sessionId, input.userId],
    )
    if (!turn.rows[0]) throw new InterruptPersistenceError("turn_not_found", "Interrupt target Turn was not found")
    const existing = await client.query<{ createdAt: Date | string }>(
      `SELECT "createdAt" FROM "agent_events"
       WHERE "sessionId" = $1 AND "turnId" = $2
         AND ("idempotencyKey" = $3 OR "type" = 'turn.interrupted')
       ORDER BY "sequence" ASC LIMIT 1`,
      [input.sessionId, input.turnId, key],
    )
    if (existing.rows[0] || turn.rows[0].status === "interrupted") {
      await client.query("COMMIT")
      committed = true
      return { ...input, reason: interruptReason(input.reason), persistedAt: toDate(existing.rows[0]?.createdAt) ?? timestamp, disposition: "duplicate" }
    }
    if (!ACTIVE_TURN_STATUSES.includes(turn.rows[0].status as typeof ACTIVE_TURN_STATUSES[number])) {
      throw new InterruptPersistenceError("turn_not_active", "Interrupt target Turn is no longer active")
    }
    const updated = await client.query(
      `UPDATE "agent_turns"
       SET "status" = 'interrupted', "revision" = "revision" + 1,
           "leaseOwnerId" = NULL, "leaseExpiresAt" = NULL, "leaseStartedAt" = NULL,
           "completedAt" = $4, "updatedAt" = $4
       WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3
         AND "status" IN ('queued', 'in_progress', 'waiting_for_dependency', 'waiting_for_approval', 'waiting_for_user')`,
      [input.turnId, input.sessionId, input.userId, timestamp],
    )
    if (updated.rowCount !== 1) throw new InterruptPersistenceError("persistence_conflict", "Interrupt target changed before Stop was persisted")
    const sequence = await client.query<{ eventSequence: bigint | string }>(
      `UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1
       WHERE "id" = $1 AND "userId" = $2 RETURNING "eventSequence"`,
      [input.sessionId, input.userId],
    )
    const next = sequence.rows[0]?.eventSequence
    if (next === undefined) throw new InterruptPersistenceError("persistence_conflict", "Interrupt session sequence is unavailable")
    const eventId = `interrupt:${input.turnId}:${input.requestId}`
    const payload = JSON.stringify({ turnId: input.turnId, requestId: input.requestId, reason: interruptReason(input.reason) })
    await client.query(
      `INSERT INTO "agent_events"
       ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload")
       VALUES ($1, $2, $3, NULL, NULL, $4, 'turn.interrupt.requested', 'system', $3, NULL, $5, $6::jsonb)`,
      [eventId, input.sessionId, input.turnId, BigInt(next).toString(), key, payload],
    )
    await client.query(
      `INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
       VALUES ($1, 'agent.session.event', $2, $3, $4::jsonb)`,
      [`agent-outbox-${eventId}`, input.sessionId, `${key}:outbox`, JSON.stringify({
        eventId, sessionId: input.sessionId, turnId: input.turnId, itemId: null, taskId: null,
        sequence: BigInt(next).toString(), type: "turn.interrupt.requested", actor: "system",
        correlationId: input.turnId, causationId: null, idempotencyKey: key,
        payload: JSON.parse(payload) as Record<string, string>,
      })],
    )
    await client.query("COMMIT")
    committed = true
    return { ...input, reason: interruptReason(input.reason), persistedAt: timestamp, disposition: "accepted" }
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function readInterrupt(pool: InterruptPersistencePool, target: InterruptTarget): Promise<boolean> {
  assertInterruptTarget(target)
  const client = await pool.connect()
  try {
    const result = await client.query<{ status: string }>(
      `SELECT "status" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
      [target.turnId, target.sessionId, target.userId],
    )
    return result.rows[0]?.status === "interrupted"
  } finally {
    client.release()
  }
}

function toDate(value: Date | string | undefined): Date | null {
  if (value === undefined) return null
  const result = value instanceof Date ? value : new Date(value)
  return Number.isNaN(result.getTime()) ? null : result
}
