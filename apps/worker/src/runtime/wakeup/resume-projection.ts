import { randomUUID } from "node:crypto"
import type pg from "pg"
import type { AgentTurnWakeupPayload } from "./types.js"

type Client = Pick<pg.PoolClient, "query">
type WakeupEventProjection = Readonly<{ sessionId: string; turnId: string; itemId: string | null; type: string; payload: unknown }>
type WakeupTurnProjection = Readonly<{
  source: string
  executionMode: string | null
  input: unknown
  rootTaskId: string | null
  hasLiveLease: boolean
}>
type WakeupItemProjection = Readonly<{ id: string; type: string; status: string; taskId: string | null; content: unknown }>
export type WakeupLeaseDisposition = "resume" | "defer" | "wait_scope_mismatch"

/** Projects only the safe resume receipt; answer or approval contents stay private. */
export async function appendResumeEvent(client: Client, payload: AgentTurnWakeupPayload, userId: string): Promise<void> {
  const sequenceResult = await client.query<{ eventSequence: string | bigint }>(
    `UPDATE "agent_sessions" AS session
     SET "eventSequence" = "eventSequence" + 1
     WHERE session."id" = $1 AND session."userId" = $2
       AND session."status" NOT IN ('aborted', 'archived')
     RETURNING "eventSequence"`,
    [payload.sessionId, userId],
  )
  const sequence = sequenceResult.rows[0]?.eventSequence
  if (sequence === undefined) throw new Error("Agent session sequence is unavailable for wakeup")
  const eventId = randomUUID()
  const eventPayload = { waitKind: payload.waitKind, waitId: payload.waitId, itemId: payload.itemId, turnId: payload.turnId, toolCallId: payload.toolCallId, status: payload.status, resumedFromEventId: payload.eventId }
  await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload") VALUES ($1, $2, $3, $4, NULL, $5, 'turn.resumed', 'system', $3, $6, $7, $8::jsonb)`, [eventId, payload.sessionId, payload.turnId, payload.itemId, String(sequence), payload.eventId, `agent-wakeup:${payload.eventId}:resumed`, JSON.stringify(eventPayload)])
  await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload") VALUES ($1, 'agent.session.event', $2, $3, $4::jsonb)`, [`agent-outbox-${eventId}`, payload.sessionId, `agent-event:${eventId}`, JSON.stringify({
    eventId, sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId,
    taskId: null, sequence: String(sequence), type: "turn.resumed", actor: "system",
    correlationId: payload.turnId, causationId: payload.eventId, idempotencyKey: `agent-wakeup:${payload.eventId}:resumed`, payload: eventPayload,
  })])
}

export async function hasMatchingWakeupEvent(client: Client, payload: AgentTurnWakeupPayload): Promise<boolean> {
  const event = (await client.query<WakeupEventProjection>(`SELECT "sessionId", "turnId", "itemId", "type", "payload" FROM "agent_events" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "itemId" = $4 AND "type" = 'turn.wakeup' FOR SHARE`, [payload.eventId, payload.sessionId, payload.turnId, payload.itemId])).rows[0]
  const value = record(event?.payload)
  if (!event || event.itemId !== payload.itemId || event.type !== "turn.wakeup" || !value) return false
  return value.waitKind === payload.waitKind && value.waitId === payload.waitId && value.itemId === payload.itemId
    && value.turnId === payload.turnId && value.toolCallId === payload.toolCallId && value.status === payload.status
    && value.nextTurnRevision === payload.nextTurnRevision
}

/** Defers only the exact live canonical wait whose owner still needs to settle it. */
export function hasReviewedApplicationReviewIntent(value: unknown): boolean {
  return record(record(value)?.intent)?.kind === "reviewed_application_review"
}

export function wakeupLeaseDisposition(
  payload: AgentTurnWakeupPayload,
  turn: WakeupTurnProjection,
  item: WakeupItemProjection,
): WakeupLeaseDisposition {
  if (hasReviewedApplicationReviewIntent(turn.input)) {
    if (!isExactReviewedApplicationReview(payload, turn, item)) return "wait_scope_mismatch"
    return turn.hasLiveLease ? "defer" : "resume"
  }
  return turn.hasLiveLease && isExactScheduledContinuationQuestion(payload, turn, item) ? "defer" : "resume"
}

function isExactScheduledContinuationQuestion(
  payload: AgentTurnWakeupPayload, turn: WakeupTurnProjection, item: WakeupItemProjection,
): boolean {
  const content = record(item.content), turnInput = record(turn.input)
  return payload.waitKind === "question" && payload.status === "answered"
    && content?.answerAvailable === true && content.answer !== null && content.answer !== undefined
    && turn.source === "automation" && turn.executionMode === "canonical_task_graph"
    && turnInput?.automationRunMode === "scheduled"
    && typeof turn.rootTaskId === "string" && turn.rootTaskId.length > 0 && (item.taskId === null || item.taskId === turn.rootTaskId)
}

function isExactReviewedApplicationReview(
  payload: AgentTurnWakeupPayload, turn: WakeupTurnProjection, item: WakeupItemProjection,
): boolean {
  const intent = reviewedApplicationReviewIntent(turn.input), content = record(item.content), impact = exactRecord(content?.impact, ["externalSubmission", "jobId"])
  return payload.waitKind === "approval" && (payload.status === "approved" || payload.status === "rejected")
    && turn.source === "user" && turn.executionMode === "canonical_task_graph" && validId(turn.rootTaskId)
    && intent !== null && validId(payload.waitId) && validId(payload.toolCallId)
    && payload.waitId === `reviewed-application-review:${payload.turnId}`
    && payload.itemId === `agent-wait:approval:${payload.waitId}`
    && item.id === payload.itemId && item.type === "approval_request" && item.status === "completed"
    && content?.waitKind === "approval" && content.approvalId === payload.waitId && content.toolCallId === payload.toolCallId
    && content.action === "review_application" && content.decision === payload.status && content.responseAvailable === true
    && typeof content.respondedAt === "string" && canonicalTimestamp(content.respondedAt)
    && impact?.externalSubmission === false && impact.jobId === intent.jobId
}

function reviewedApplicationReviewIntent(value: unknown): { jobId: string; sourceTurnId: string } | null {
  const input = record(value), intent = exactRecord(input?.intent, ["kind", "version", "sourceTurnId", "jobId"])
  if (!intent || intent.kind !== "reviewed_application_review" || intent.version !== 1
    || !validId(intent.sourceTurnId) || !validId(intent.jobId)) return null
  return { sourceTurnId: intent.sourceTurnId, jobId: intent.jobId }
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
  } catch { return null }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const parsed = record(value)
  if (!parsed) return null
  try {
    const own = Reflect.ownKeys(parsed)
    return own.length === keys.length && own.every(key => typeof key === "string" && keys.includes(key))
      && keys.every(key => { const descriptor = Object.getOwnPropertyDescriptor(parsed, key); return Boolean(descriptor?.enumerable && "value" in descriptor) })
      ? parsed : null
  } catch { return null }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function canonicalTimestamp(value: string): boolean {
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}
