import type pg from "pg"

import {
  assertInterruptTarget,
  interruptReason,
  interruptTargetKey,
  type TerminalEventInput,
  type TerminalEventPort,
  type TerminalEventResult,
  type InterruptTarget,
} from "./types.js"

export class TerminalEventConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TerminalEventConflictError"
  }
}

/** In-memory reducer used by tests and by embedders that already persist events. */
export class InMemoryTerminalEventPort implements TerminalEventPort {
  private readonly terminalEvents = new Map<string, TerminalEventInput>()

  async append(input: TerminalEventInput): Promise<TerminalEventResult> {
    assertInterruptTarget(input)
    const key = interruptTargetKey(input)
    if (this.terminalEvents.has(key)) return "duplicate"
    this.terminalEvents.set(key, { ...input, reason: interruptReason(input.reason) })
    return "appended"
  }

  events(target?: InterruptTarget): readonly TerminalEventInput[] {
    if (!target) return [...this.terminalEvents.values()]
    const existing = this.terminalEvents.get(interruptTargetKey(target))
    return existing ? [existing] : []
  }
}

export type TerminalEventPool = Pick<pg.Pool, "connect">

/** Durable terminal event adapter. The existing Web interrupt event is recognized as the same terminal. */
export function createPgTerminalEventPort(pool: TerminalEventPool, now: () => Date = () => new Date()): TerminalEventPort {
  return { append: (input) => appendTerminalEvent(pool, input, now) }
}

async function appendTerminalEvent(pool: TerminalEventPool, input: TerminalEventInput, now: () => Date): Promise<TerminalEventResult> {
  assertInterruptTarget(input)
  const timestamp = now()
  const client = await pool.connect()
  let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", input.userId])
    const turn = await client.query<{ status: string }>(
      `SELECT "status" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 FOR UPDATE`,
      [input.turnId, input.sessionId, input.userId],
    )
    if (!turn.rows[0]) throw new TerminalEventConflictError("Terminal event target Turn was not found")
    const existing = await client.query<{ type: string }>(
      `SELECT "type" FROM "agent_events"
       WHERE "sessionId" = $1 AND "turnId" = $2
         AND "type" IN ('turn.completed', 'turn.failed', 'turn.interrupted')
       ORDER BY "sequence" ASC LIMIT 1`,
      [input.sessionId, input.turnId],
    )
    if (existing.rows[0]) {
      if (existing.rows[0].type === "turn.interrupted") {
        await client.query("COMMIT")
        committed = true
        return "duplicate"
      }
      throw new TerminalEventConflictError(`Turn already has terminal event ${existing.rows[0].type}`)
    }
    if (turn.rows[0].status !== "interrupted") {
      const updated = await client.query(
        `UPDATE "agent_turns"
         SET "status" = 'interrupted', "revision" = "revision" + 1,
             "leaseOwnerId" = NULL, "leaseExpiresAt" = NULL, "leaseStartedAt" = NULL,
             "completedAt" = $4, "updatedAt" = $4
         WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3
           AND "status" IN ('queued', 'in_progress', 'waiting_for_dependency', 'waiting_for_approval', 'waiting_for_user')`,
        [input.turnId, input.sessionId, input.userId, timestamp],
      )
      if (updated.rowCount !== 1) throw new TerminalEventConflictError("Turn changed before terminal interrupt event")
    }
    const sequence = await client.query<{ eventSequence: bigint | string }>(
      `UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1
       WHERE "id" = $1 AND "userId" = $2 RETURNING "eventSequence"`,
      [input.sessionId, input.userId],
    )
    const next = sequence.rows[0]?.eventSequence
    if (next === undefined) throw new TerminalEventConflictError("Terminal event session sequence is unavailable")
    const key = `agent-turn:${input.sessionId}:${input.turnId}:terminal`
    const eventId = `terminal:${input.turnId}`
    const payloadDetails = input.payload && typeof input.payload === "object" && !Array.isArray(input.payload) ? input.payload : {}
    const payload = JSON.stringify({
      turnId: input.turnId,
      requestId: input.requestId,
      reason: interruptReason(input.reason),
      ...payloadDetails,
    })
    await client.query(
      `INSERT INTO "agent_events"
       ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload")
       VALUES ($1, $2, $3, NULL, NULL, $4, 'turn.interrupted', 'system', $3, $5, $6, $7::jsonb)`,
      [eventId, input.sessionId, input.turnId, BigInt(next).toString(), input.requestId, key, payload],
    )
    await client.query(
      `INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
       VALUES ($1, 'agent.session.event', $2, $3, $4::jsonb)`,
      [`agent-outbox-${eventId}`, input.sessionId, `${key}:outbox`, JSON.stringify({
        eventId, sessionId: input.sessionId, turnId: input.turnId, itemId: null, taskId: null,
        sequence: BigInt(next).toString(), type: "turn.interrupted", actor: "system",
        correlationId: input.turnId, causationId: input.requestId, idempotencyKey: key,
        payload: JSON.parse(payload) as Record<string, unknown>,
      })],
    )
    await client.query("COMMIT")
    committed = true
    return "appended"
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
