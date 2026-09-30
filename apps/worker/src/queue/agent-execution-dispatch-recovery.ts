import { createHash } from "node:crypto"
import type pg from "pg"
import type { LeasePool } from "../runtime/turns/lease.js"
import { enqueueOrRecoverAgentRunJob, terminalizeExhaustedAgentRunDispatch, type DispatchJobQueue } from "./agent-execution-dispatch-job-recovery.js"
import { legacyResumeFailureReasonFromBull } from "./agent-run-legacy-terminal-failure.js"

export const AGENT_EXECUTION_DISPATCH_TOPIC = "agent.execution.dispatch"
export const AGENT_EXECUTION_DISPATCH_POLL_MS = 1_000
const MAX_BATCH_SIZE = 50
const STALE_TURN_ERROR = "This question can no longer be resumed. Please start a new agent run."
const pendingCursorByPool = new WeakMap<LeasePool, string>()
type DispatchPayload = { userId: string; sessionId: string; executionId: string; attemptCount: number; questionId: string }
type OutboxRow = { id: string; aggregateId: string; idempotencyKey: string; payload: unknown; attemptCount: number }
type SessionRow = { id: string; userId: string; status: string }
type TurnRow = { id: string; sessionId: string; userId: string; status: string }
type ExecutionRow = { id: string; status: string; attemptCount: number; workerTaskId: string | null }
type QuestionRow = { id: string; userId: string; runId: string; answer: string | null }
type Outcome = "published" | "resolved" | "stale" | "skipped"
type QuestionScope = { kind: "turn"; turnId: string } | { kind: "legacy" }
function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim()
}
function parsePayload(value: unknown): DispatchPayload | null {
  const row = objectRecord(value)
  if (!row || Object.keys(row).length !== 5) return null
  const { userId, sessionId, executionId, attemptCount, questionId } = row
  if (!nonEmptyString(userId) || !nonEmptyString(sessionId) || !nonEmptyString(executionId) || !nonEmptyString(questionId)) return null
  if (!Number.isSafeInteger(attemptCount) || (attemptCount as number) < 0) return null
  return { userId, sessionId, executionId, attemptCount: attemptCount as number, questionId }
}
function questionScope(questionId: string): QuestionScope | null {
  const prefix = "agent-question:"
  if (!questionId.startsWith(prefix)) return { kind: "legacy" }
  const suffix = questionId.slice(prefix.length)
  const separator = suffix.indexOf(":")
  if (separator < 1 || separator === suffix.length - 1) return null
  const questionKey = suffix.slice(separator + 1)
  if (!questionKey.startsWith("legacy:") || questionKey.length === "legacy:".length) return null
  return { kind: "turn", turnId: suffix.slice(0, separator) }
}
function expectedIdempotencyKey(payload: DispatchPayload): string {
  return `legacy-execution-dispatch:${payload.executionId}:${payload.attemptCount}:${payload.questionId}`
}
export function agentExecutionDispatchJobId(idempotencyKey: string): string {
  const digest = createHash("sha256").update(idempotencyKey).digest("hex")
  return `agent-execution-dispatch-${digest}`
}
async function transaction<T>(pool: LeasePool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
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
async function selectPending(pool: LeasePool, limit: number): Promise<OutboxRow[]> {
  const selectPage = (afterId?: string) => transaction(pool, async client => (await client.query<OutboxRow>(`SELECT dispatch."id", dispatch."aggregateId", dispatch."idempotencyKey", dispatch."payload", dispatch."attemptCount"
    FROM "agent_outbox" AS dispatch
    WHERE dispatch."topic" = $1 AND dispatch."publishedAt" IS NULL AND ($3 IS NULL OR dispatch."id" > $3)
    ORDER BY dispatch."id" ASC LIMIT $2 FOR UPDATE SKIP LOCKED`, [AGENT_EXECUTION_DISPATCH_TOPIC, limit, afterId ?? null])).rows)
  let cursor = pendingCursorByPool.get(pool)
  let rows = await selectPage(cursor)
  if (!rows.length && cursor !== undefined) { cursor = undefined; rows = await selectPage() }
  if (rows.length) pendingCursorByPool.set(pool, rows[rows.length - 1]!.id)
  return rows
}
async function lockSession(client: pg.PoolClient, sessionId: string): Promise<SessionRow | undefined> {
  return (await client.query<SessionRow>(`SELECT session."id", session."userId", session."status"
    FROM "agent_sessions" AS session WHERE session."id" = $1 FOR UPDATE`, [sessionId])).rows[0]
}
async function lockPending(client: pg.PoolClient, row: OutboxRow): Promise<OutboxRow | undefined> {
  return (await client.query<OutboxRow>(`SELECT dispatch."id", dispatch."aggregateId", dispatch."idempotencyKey", dispatch."payload", dispatch."attemptCount"
    FROM "agent_outbox" AS dispatch
    WHERE dispatch."id" = $1 AND dispatch."aggregateId" = $2 AND dispatch."topic" = $3 AND dispatch."publishedAt" IS NULL
    FOR UPDATE`, [row.id, row.aggregateId, AGENT_EXECUTION_DISPATCH_TOPIC])).rows[0]
}
async function lockTurn(client: pg.PoolClient, turnId: string, payload: DispatchPayload): Promise<TurnRow | undefined> {
  return (await client.query<TurnRow>(`SELECT turn."id", turn."sessionId", turn."userId", turn."status"
    FROM "agent_turns" AS turn
    WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3
    FOR UPDATE`, [turnId, payload.sessionId, payload.userId])).rows[0]
}
async function lockActiveTurns(client: pg.PoolClient, payload: DispatchPayload): Promise<TurnRow[]> {
  return (await client.query<TurnRow>(`SELECT turn."id", turn."sessionId", turn."userId", turn."status"
    FROM "agent_turns" AS turn
    WHERE turn."sessionId" = $1 AND turn."userId" = $2
      AND turn."status" = ANY($3::text[])
    ORDER BY turn."id" FOR UPDATE`, [payload.sessionId, payload.userId,
    ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"]])).rows
}
async function lockExecution(client: pg.PoolClient, payload: DispatchPayload): Promise<ExecutionRow | undefined> {
  return (await client.query<ExecutionRow>(`SELECT execution."id", execution."status", execution."attemptCount", execution."workerTaskId"
    FROM "agent_executions" AS execution
    WHERE execution."id" = $1 AND execution."sessionId" = $2 AND execution."userId" = $3
    FOR UPDATE`, [payload.executionId, payload.sessionId, payload.userId])).rows[0]
}
async function lockQuestion(client: pg.PoolClient, payload: DispatchPayload): Promise<QuestionRow | undefined> {
  return (await client.query<QuestionRow>(`SELECT question."id", question."userId", question."runId", question."answer"
    FROM "AgentRunQuestion" AS question
    WHERE question."id" = $1 AND question."userId" = $2 AND question."runId" = $3
    FOR UPDATE`, [payload.questionId, payload.userId, payload.sessionId])).rows[0]
}
async function markTerminal(client: pg.PoolClient, row: OutboxRow, reason: string): Promise<void> {
  await client.query(`UPDATE "agent_outbox"
    SET "publishedAt" = CURRENT_TIMESTAMP, "attemptCount" = "attemptCount" + 1, "lastError" = $4
    WHERE "id" = $1 AND "aggregateId" = $2 AND "topic" = $3 AND "publishedAt" IS NULL`,
  [row.id, row.aggregateId, AGENT_EXECUTION_DISPATCH_TOPIC, reason])
}
async function stale(client: pg.PoolClient, row: OutboxRow, reason: string) {
  await markTerminal(client, row, reason)
  return { outcome: "stale" as const }
}
async function failStaleExecution(client: pg.PoolClient, row: OutboxRow, payload: DispatchPayload, jobId: string, reason: string) {
  await client.query(`UPDATE "agent_executions"
    SET "status" = 'failed', "error" = $6, "completedAt" = CURRENT_TIMESTAMP
    WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3 AND "attemptCount" = $4
      AND ("workerTaskId" IS NULL OR "workerTaskId" = $5) AND "status" = 'queued'`,
  [payload.executionId, payload.userId, payload.sessionId, payload.attemptCount, jobId, STALE_TURN_ERROR])
  return stale(client, row, reason)
}
async function markPublished(client: pg.PoolClient, row: OutboxRow): Promise<number> {
  const result = await client.query(`UPDATE "agent_outbox"
    SET "publishedAt" = CURRENT_TIMESTAMP, "attemptCount" = "attemptCount" + 1, "lastError" = NULL
    WHERE "id" = $1 AND "aggregateId" = $2 AND "topic" = $3 AND "publishedAt" IS NULL`,
  [row.id, row.aggregateId, AGENT_EXECUTION_DISPATCH_TOPIC])
  return result.rowCount ?? 0
}
async function markRetry(pool: LeasePool, row: OutboxRow, reason: string): Promise<void> {
  await transaction(pool, async client => {
    await client.query(`UPDATE "agent_outbox"
      SET "attemptCount" = "attemptCount" + 1, "lastError" = $4
      WHERE "id" = $1 AND "aggregateId" = $2 AND "topic" = $3 AND "publishedAt" IS NULL`,
    [row.id, row.aggregateId, AGENT_EXECUTION_DISPATCH_TOPIC, reason])
  })
}
async function processRow(pool: LeasePool, queue: DispatchJobQueue, scanned: OutboxRow): Promise<Outcome> {
  const prepared = await transaction(pool, async client => {
      const session = await lockSession(client, scanned.aggregateId)
      const row = await lockPending(client, scanned)
      if (!row) return { outcome: "skipped" as const }
      const payload = parsePayload(row.payload)
      if (!payload) return stale(client, row, "schema_invalid_payload")
      if (row.aggregateId !== payload.sessionId || row.idempotencyKey !== expectedIdempotencyKey(payload)) {
        return stale(client, row, "outbox_scope_mismatch")
      }
      if (!session) return stale(client, row, "session_missing")
      if (session.userId !== payload.userId) return stale(client, row, "session_owner_mismatch")
      if (session.status === "aborted" || session.status === "archived") {
        return stale(client, row, "session_unavailable")
      }

      const scope = questionScope(payload.questionId)
      const turn = scope?.kind === "turn" ? await lockTurn(client, scope.turnId, payload) : undefined
      const question = await lockQuestion(client, payload)
      const execution = await lockExecution(client, payload)
      if (!execution) return stale(client, row, "execution_scope_mismatch")
      const jobId = agentExecutionDispatchJobId(row.idempotencyKey)
      if (execution.workerTaskId === jobId && execution.attemptCount > payload.attemptCount && execution.status !== "queued") {
        await markPublished(client, row)
        return { outcome: "resolved" as const }
      }
      if (!scope) return failStaleExecution(client, row, payload, jobId, "question_turn_invalid")
      if (scope.kind === "turn" && !turn) return failStaleExecution(client, row, payload, jobId, "turn_scope_mismatch")
      if (!question || question.answer === null) return failStaleExecution(client, row, payload, jobId, "question_unanswered_or_missing")
      const activeTurns = scope.kind === "legacy" ? await lockActiveTurns(client, payload) : []
      if (activeTurns.length) return failStaleExecution(client, row, payload, jobId, "canonical_turn_active")
      if (scope.kind === "turn" && turn?.status !== "waiting_for_user") {
        return failStaleExecution(client, row, payload, jobId, "turn_not_waiting")
      }
      if (execution.status !== "queued" || execution.attemptCount !== payload.attemptCount ||
        (execution.workerTaskId !== null && execution.workerTaskId !== jobId)) {
        return stale(client, row, "execution_attempt_stale")
      }
      const taskUpdated = await client.query(`UPDATE "agent_executions"
        SET "workerTaskId" = $4
        WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3
          AND "status" = 'queued' AND "attemptCount" = $5 AND ("workerTaskId" IS NULL OR "workerTaskId" = $4)`,
      [payload.executionId, payload.userId, payload.sessionId, jobId, payload.attemptCount])
      if (taskUpdated.rowCount !== 1) {
        return stale(client, row, "execution_owner_changed")
      }
      return {
        outcome: "ready" as const,
        row,
        payload,
        jobId,
        ...(scope.kind === "turn" ? { legacyTurnId: scope.turnId } : {}),
      }
  })
  if (prepared.outcome !== "ready") return prepared.outcome

  let recovery: Awaited<ReturnType<typeof enqueueOrRecoverAgentRunJob>>
  try {
    recovery = await enqueueOrRecoverAgentRunJob(queue, prepared.jobId, {
      userId: prepared.payload.userId,
      sessionId: prepared.payload.sessionId,
      executionId: prepared.payload.executionId,
      attemptCount: prepared.payload.attemptCount,
      questionId: prepared.payload.questionId,
      ...(prepared.legacyTurnId === undefined ? {} : { legacyTurnId: prepared.legacyTurnId }),
    })
  } catch (error: unknown) {
    await markRetry(pool, prepared.row, "queue_add_failed").catch(() => undefined)
    throw error
  }
  if (recovery.kind === "exhausted") {
    const reason = legacyResumeFailureReasonFromBull(recovery.failedReason) ?? "retry_exhausted"
    if (!await terminalizeExhaustedAgentRunDispatch(pool, prepared, reason)) return "skipped"
    await transaction(pool, client => markTerminal(client, prepared.row, reason))
    return "resolved"
  }
  try {
    await transaction(pool, client => markPublished(client, prepared.row))
  } catch (error: unknown) {
    // A retry uses the persisted workerTaskId and deterministic jobId to close
    // the crash window after Redis accepted the job but before outbox marking.
    throw new Error("agent_execution_dispatch_delivery_uncertain", { cause: error })
  }
  return "published"
}

export async function dispatchPendingAgentExecutionOutbox(pool: LeasePool, queue: DispatchJobQueue, limit = MAX_BATCH_SIZE): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Agent execution dispatch limit must be positive")
  const rows = await selectPending(pool, Math.min(limit, MAX_BATCH_SIZE))
  let dispatched = 0
  let firstError: unknown
  let failed = false
  for (const row of rows) {
    try {
      if ((await processRow(pool, queue, row)) === "published") dispatched += 1
    } catch (error: unknown) {
      if (!failed) { firstError = error; failed = true }
    }
  }
  if (failed) throw firstError
  return dispatched
}
