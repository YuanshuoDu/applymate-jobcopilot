import { randomUUID } from "node:crypto"

import type pg from "pg"

import { TurnLeaseError, type LeasePool, type TurnJobPayload } from "./lease.js"

export const TURN_MAX_ATTEMPTS = 5
export const TURN_DLQ_TOPIC = "agent.turn.dlq"

export type TurnFailureReasonCode =
  | "schema_invalid_payload"
  | "max_retries_exhausted"
  | "execution_failed"
  | "lease_lost"

export type TurnFailureDecision =
  | { disposition: "retry"; reasonCode: "execution_failed" | "lease_lost" }
  | { disposition: "dead_letter"; reasonCode: "schema_invalid_payload" | "max_retries_exhausted" }
  | { disposition: "skip"; reasonCode: "lease_not_available" }

export type TurnDlqEvent = {
  turnId: string | null
  sessionId: string | null
  ownerId: string | null
  attemptsMade: number
  reason_code: TurnFailureReasonCode
  error_code: string
}
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Unknown Turn execution failure")
}

export function classifyTurnFailure(
  error: unknown,
  attemptsMade: number,
  maxAttempts = TURN_MAX_ATTEMPTS,
): TurnFailureDecision {
  if (error instanceof TurnLeaseError && error.code === "lease_not_available") {
    return { disposition: "skip", reasonCode: "lease_not_available" }
  }
  if (error instanceof TurnLeaseError && error.code === "lease_lost") {
    return { disposition: "retry", reasonCode: "lease_lost" }
  }
  if (error instanceof SyntaxError || asError(error).name === "TurnQueuePayloadError") {
    return { disposition: "dead_letter", reasonCode: "schema_invalid_payload" }
  }
  if (!Number.isInteger(attemptsMade) || attemptsMade + 1 >= maxAttempts) {
    return { disposition: "dead_letter", reasonCode: "max_retries_exhausted" }
  }
  return { disposition: "retry", reasonCode: "execution_failed" }
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200 ? value : null
}

export function payloadIdentity(value: unknown): Pick<TurnDlqEvent, "turnId" | "sessionId" | "ownerId"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { turnId: null, sessionId: null, ownerId: null }
  const row = value as Record<string, unknown>
  return { turnId: safeString(row.turnId), sessionId: safeString(row.sessionId), ownerId: safeString(row.ownerId) }
}

function errorCode(error: unknown): string {
  if (error instanceof TurnLeaseError) return error.code
  if (error instanceof Error && error.name === "TurnQueuePayloadError") return "invalid_payload"
  return "turn_execution_error"
}

/** Writes only typed operational metadata; never persists model/tool payloads. */
export async function recordTurnDlq(
  pool: LeasePool,
  payload: unknown,
  attemptsMade: number,
  reasonCode: TurnFailureReasonCode,
  error: unknown,
): Promise<void> {
  const identity = payloadIdentity(payload)
  const event: TurnDlqEvent = {
    ...identity,
    attemptsMade,
    reason_code: reasonCode,
    error_code: errorCode(error),
  }
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query(
      `INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT ("idempotencyKey") DO NOTHING`,
      [
        randomUUID(),
        TURN_DLQ_TOPIC,
        identity.turnId ?? "unknown-turn",
        `turn-dlq:${identity.turnId ?? "unknown"}:${attemptsMade}:${reasonCode}`,
        JSON.stringify(event),
      ],
    )
    await client.query("COMMIT")
  } catch (failure: unknown) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw failure
  } finally {
    client.release()
  }
}
