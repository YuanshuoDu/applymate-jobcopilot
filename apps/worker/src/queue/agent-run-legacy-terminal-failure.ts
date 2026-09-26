import { createHash } from "node:crypto"
import type pg from "pg"

export type LegacyResumeFailureReason = "authorization_revoked" | "retry_exhausted"
const TERMINALIZATION_FAILURE_PREFIX = "legacy_resume_terminalization_failed:"
export const LEGACY_RESUME_EXECUTION_STALE_MS = Number(process.env.AGENT_EXECUTION_STALE_MS ?? 15_000)
const ACTIVE_TURNS = ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"]

export function legacyResumeTerminalizationFailure(reason: LegacyResumeFailureReason, cause: unknown): Error {
  const error = new Error(`${TERMINALIZATION_FAILURE_PREFIX}${reason}`, { cause }); error.name = "LegacyResumeTerminalizationError"; return error
}

export function legacyResumeFailureReasonFromBull(failedReason: unknown): LegacyResumeFailureReason | null {
  const message = failedReason instanceof Error ? failedReason.message : failedReason
  if (message === `${TERMINALIZATION_FAILURE_PREFIX}authorization_revoked`) return "authorization_revoked"; if (message === `${TERMINALIZATION_FAILURE_PREFIX}retry_exhausted`) return "retry_exhausted"
  return null
}

export type LegacyResumeFailureInput = { userId: string; sessionId: string; executionId: string; attemptCount: number; workerTaskId: string; questionId: string; legacyTurnId: string; reason: LegacyResumeFailureReason; staleRunning?: { staleBefore: Date } }
export type UnnamespacedLegacyResumeFailureInput = { userId: string; sessionId: string; executionId: string; attemptCount: number; workerTaskId: string; questionId: string; reason: LegacyResumeFailureReason; staleBefore: Date }
type Pool = Pick<pg.Pool, "connect">
type Client = Pick<pg.PoolClient, "query" | "release">
type Row = Record<string, unknown>
type FailureEvent = { id: string; sequence: string; type: string; actor: string; correlationId: string; causationId: string | null; payload: unknown }
type EventOutbox = { id: string; topic: string; aggregateId: string; idempotencyKey: string; payload: unknown }

const AUTHORIZATION_FAILURE = "Authorization was revoked before this agent run started."
const RETRY_EXHAUSTED_FAILURE = "This agent run could not start after retrying. Please try again."

export function legacyResumeStaleBefore(now = Date.now()): Date | null {
  if (!Number.isFinite(LEGACY_RESUME_EXECUTION_STALE_MS) || LEGACY_RESUME_EXECUTION_STALE_MS <= 0 || !Number.isFinite(now)) return null
  const staleBefore = new Date(now - LEGACY_RESUME_EXECUTION_STALE_MS); return Number.isFinite(staleBefore.getTime()) ? staleBefore : null
}

async function transaction<T>(pool: Pool, userId: string, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", userId])
    const result = await work(client)
    await client.query("COMMIT")
    return result
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

function exactLegacyTurn(questionId: string): string | null {
  const prefix = "agent-question:"; if (!questionId.startsWith(prefix)) return null
  const namespaced = questionId.slice(prefix.length); const separator = namespaced.indexOf(":"); if (separator < 1) return null
  const turnId = namespaced.slice(0, separator); const suffix = namespaced.slice(separator + 1)
  return suffix.startsWith("legacy:") && suffix.length > "legacy:".length ? turnId : null
}

function failureDetails(input: LegacyResumeFailureInput) {
  const message = input.reason === "authorization_revoked" ? AUTHORIZATION_FAILURE : RETRY_EXHAUSTED_FAILURE; const reason = input.reason === "authorization_revoked" ? "worker_authorization_revoked" : "worker_retry_exhausted"
  const idempotencyKey = `legacy-turn-worker-terminal-failed:${input.workerTaskId}:${input.reason}`
  const digest = createHash("sha256").update(`${input.sessionId}\0${idempotencyKey}`).digest("hex")
  return { message, idempotencyKey, eventId: `legacy-turn-failure:${digest}`, payload: { turnId: input.legacyTurnId, reason, message } }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${stableJson(row[key])}`).join(",")}}`
  }
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError("value is not JSON")
  return serialized
}

function outboxMatches(value: unknown, expected: EventOutbox): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  let payload = row.payload
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload) as unknown } catch { return false }
  }
  try {
    return row.id === expected.id && row.topic === expected.topic && row.aggregateId === expected.aggregateId &&
      row.idempotencyKey === expected.idempotencyKey && stableJson(payload) === stableJson(expected.payload)
  } catch { return false }
}
async function ensureEventOutbox(client: Client, expected: EventOutbox): Promise<void> {
  const inserted = await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
    VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT ("idempotencyKey") DO NOTHING`,
  [expected.id, expected.topic, expected.aggregateId, expected.idempotencyKey, JSON.stringify(expected.payload)])
  if ((inserted.rowCount ?? 0) === 1) return
  const existing = await client.query<EventOutbox>(`SELECT "id", "topic", "aggregateId", "idempotencyKey", "payload"
    FROM "agent_outbox" WHERE "idempotencyKey" = $1 FOR UPDATE`, [expected.idempotencyKey])
  if (!outboxMatches(existing.rows[0], expected)) throw new Error("legacy_turn_failure_outbox_identity_conflict")
}

/** Fails only the exact answered, stale-running unnamespaced legacy resume. */
export async function failStaleUnnamespacedLegacyResume(
  pool: Pool,
  input: UnnamespacedLegacyResumeFailureInput,
): Promise<boolean> {
  if (!input.userId || !input.sessionId || !input.executionId || !input.workerTaskId || !input.questionId ||
    input.questionId.startsWith("agent-question:") || !Number.isSafeInteger(input.attemptCount) ||
    input.attemptCount < 0 || input.attemptCount >= Number.MAX_SAFE_INTEGER ||
    !(input.staleBefore instanceof Date) || !Number.isFinite(input.staleBefore.getTime())) return false

  return transaction(pool, input.userId, async client => {
    const session = await client.query<Row>(`SELECT "id", "status" FROM "agent_sessions"
      WHERE "id" = $1 AND "userId" = $2 AND "status" NOT IN ('aborted', 'archived') FOR UPDATE`,
    [input.sessionId, input.userId])
    if (!session.rows[0]) return false

    if (input.reason !== "authorization_revoked") {
      const activeTurns = await client.query<Row>(`SELECT "id" FROM "agent_turns"
        WHERE "sessionId" = $1 AND "userId" = $2 AND "status" = ANY($3::text[]) ORDER BY "id" FOR UPDATE`,
      [input.sessionId, input.userId, ACTIVE_TURNS])
      if (activeTurns.rows.length) return false
    }

    const question = await client.query<Row>(`SELECT "id", "answer" FROM "AgentRunQuestion"
      WHERE "id" = $1 AND "userId" = $2 AND "runId" = $3 FOR UPDATE`,
    [input.questionId, input.userId, input.sessionId])
    if (!question.rows[0] || question.rows[0].answer === null || question.rows[0].answer === undefined) return false

    const execution = await client.query<Row>(`SELECT "id", "status", "attemptCount", "workerTaskId", "updatedAt" FROM "agent_executions"
      WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 FOR UPDATE`,
    [input.executionId, input.sessionId, input.userId])
    const exactExecution = execution.rows[0]
    const currentAttempt = exactExecution?.attemptCount
    const updatedAt = exactExecution?.updatedAt instanceof Date
      ? exactExecution.updatedAt.getTime()
      : new Date(String(exactExecution?.updatedAt)).getTime()
    if (exactExecution?.status !== "running" || exactExecution.workerTaskId !== input.workerTaskId ||
      !Number.isSafeInteger(currentAttempt) || (currentAttempt as number) <= input.attemptCount ||
      (currentAttempt as number) >= Number.MAX_SAFE_INTEGER || !Number.isFinite(updatedAt) ||
      updatedAt >= input.staleBefore.getTime()) return false

    const message = input.reason === "authorization_revoked" ? AUTHORIZATION_FAILURE : RETRY_EXHAUSTED_FAILURE
    const failed = await client.query(`UPDATE "agent_executions"
      SET "status" = 'failed', "error" = $7, "completedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "attemptCount" = $4
        AND "workerTaskId" = $5 AND "status" = 'running' AND "updatedAt" < $6`,
    [input.executionId, input.sessionId, input.userId, currentAttempt, input.workerTaskId, input.staleBefore, message])
    return (failed.rowCount ?? 0) === 1
  })
}

/** Closes the exact queued legacy resume, or a stale-running attempt on its linked Turn. */
export async function failTurnScopedLegacyResume(pool: Pool, input: LegacyResumeFailureInput): Promise<boolean> {
  if (!input.userId || !input.sessionId || !input.executionId || !input.workerTaskId || !input.questionId ||
    !input.legacyTurnId || !Number.isSafeInteger(input.attemptCount) || input.attemptCount < 0 || input.attemptCount >= Number.MAX_SAFE_INTEGER ||
    exactLegacyTurn(input.questionId) !== input.legacyTurnId) return false
  if (input.staleRunning && (input.attemptCount >= Number.MAX_SAFE_INTEGER - 1 ||
    !(input.staleRunning.staleBefore instanceof Date) || !Number.isFinite(input.staleRunning.staleBefore.getTime()))) return false

  return transaction(pool, input.userId, async client => {
    const session = await client.query<Row>(`SELECT "id", "status" FROM "agent_sessions"
      WHERE "id" = $1 AND "userId" = $2 AND "status" NOT IN ('aborted', 'archived') FOR UPDATE`,
    [input.sessionId, input.userId])
    if (!session.rows[0]) return false

    const turn = await client.query<Row>(`SELECT "id", "status" FROM "agent_turns"
      WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 FOR UPDATE`,
    [input.legacyTurnId, input.sessionId, input.userId])
    const waitingTurn = turn.rows[0]?.status === "waiting_for_user"
    const staleActiveTurn = input.staleRunning !== undefined && turn.rows[0]?.status === "in_progress"
    if (!waitingTurn && !staleActiveTurn) return false

    const question = await client.query<Row>(`SELECT "id", "answer" FROM "AgentRunQuestion"
      WHERE "id" = $1 AND "userId" = $2 AND "runId" = $3 FOR UPDATE`,
    [input.questionId, input.userId, input.sessionId])
    if (!question.rows[0] || question.rows[0].answer === null || question.rows[0].answer === undefined) return false

    const execution = await client.query<Row>(`SELECT "id", "status", "attemptCount", "workerTaskId", "updatedAt" FROM "agent_executions"
      WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 FOR UPDATE`,
    [input.executionId, input.sessionId, input.userId])
    const exactExecution = execution.rows[0]
    const updatedAt = exactExecution?.updatedAt instanceof Date
      ? exactExecution.updatedAt.getTime()
      : new Date(String(exactExecution?.updatedAt)).getTime()
    const currentAttempt = exactExecution?.attemptCount
    const exactQueued = waitingTurn && (!input.staleRunning || input.reason === "authorization_revoked") &&
      exactExecution?.status === "queued" && currentAttempt === input.attemptCount &&
      exactExecution.workerTaskId === input.workerTaskId
    const exactStaleRunning = staleActiveTurn && input.staleRunning !== undefined && exactExecution?.status === "running" &&
      Number.isSafeInteger(currentAttempt) && (currentAttempt as number) >= input.attemptCount + 1 &&
      (currentAttempt as number) < Number.MAX_SAFE_INTEGER && exactExecution.workerTaskId === input.workerTaskId &&
      Number.isFinite(updatedAt) && updatedAt < input.staleRunning.staleBefore.getTime()
    if (!exactQueued && !exactStaleRunning) return false

    const details = failureDetails(input)
    const failedExecution = exactStaleRunning && input.staleRunning
      ? await client.query(`UPDATE "agent_executions"
        SET "status" = 'failed', "checkpoint" = 'failed', "error" = $5, "completedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "attemptCount" = $4
          AND "workerTaskId" = $6 AND "status" = 'running' AND "updatedAt" < $7`,
      [input.executionId, input.sessionId, input.userId, currentAttempt as number, details.message,
        input.workerTaskId, input.staleRunning.staleBefore])
      : await client.query(`UPDATE "agent_executions"
        SET "status" = 'failed', "checkpoint" = 'failed', "error" = $5, "completedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "attemptCount" = $4
          AND "workerTaskId" = $6 AND "status" = 'queued'`,
      [input.executionId, input.sessionId, input.userId, input.attemptCount, details.message, input.workerTaskId])
    if ((failedExecution.rowCount ?? 0) !== 1) return false

    const expectedTurnStatus = staleActiveTurn ? "in_progress" : "waiting_for_user"
    const failedTurn = await client.query(`UPDATE "agent_turns"
      SET "status" = 'failed', "error" = $4, "revision" = "revision" + 1,
          "leaseOwnerId" = NULL, "leaseExpiresAt" = NULL, "leaseStartedAt" = NULL,
          "completedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "status" = $5`,
    [input.legacyTurnId, input.sessionId, input.userId, details.message, expectedTurnStatus])
    if ((failedTurn.rowCount ?? 0) !== 1) throw new Error("legacy_turn_failure_turn_fence_lost")

    const sequence = await client.query<{ eventSequence: bigint | string }>(`UPDATE "agent_sessions"
      SET "eventSequence" = "eventSequence" + 1 WHERE "id" = $1 AND "userId" = $2 RETURNING "eventSequence"`,
    [input.sessionId, input.userId])
    const eventSequence = sequence.rows[0]?.eventSequence
    if (eventSequence === undefined) throw new Error("legacy_turn_failure_event_sequence_missing")

    const event = {
      eventId: details.eventId,
      sessionId: input.sessionId,
      turnId: input.legacyTurnId,
      itemId: null,
      taskId: null,
      sequence: String(eventSequence),
      type: "turn.failed",
      actor: "orchestrator",
      correlationId: input.legacyTurnId,
      causationId: null,
      idempotencyKey: details.idempotencyKey,
      payload: details.payload,
    }
    await client.query(`INSERT INTO "agent_events"
      ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload")
      VALUES ($1, $2, $3, NULL, NULL, $4, 'turn.failed', 'orchestrator', $3, NULL, $5, $6::jsonb)`,
    [details.eventId, input.sessionId, input.legacyTurnId, String(eventSequence), details.idempotencyKey, JSON.stringify(details.payload)])

    await ensureEventOutbox(client, {
      id: `agent-outbox-${details.eventId}`,
      topic: "agent.session.event",
      aggregateId: input.sessionId,
      idempotencyKey: `agent-event:${details.eventId}`,
      payload: event,
    })
    return true
  })
}
