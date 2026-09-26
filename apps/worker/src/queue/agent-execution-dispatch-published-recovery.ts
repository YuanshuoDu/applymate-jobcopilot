import type pg from "pg"
import type { LeasePool } from "../runtime/turns/lease.js"
import { failStaleUnnamespacedLegacyResume, failTurnScopedLegacyResume, LEGACY_RESUME_EXECUTION_STALE_MS, legacyResumeFailureReasonFromBull, legacyResumeStaleBefore, type LegacyResumeFailureReason } from "./agent-run-legacy-terminal-failure.js"
import { agentExecutionDispatchJobId, AGENT_EXECUTION_DISPATCH_TOPIC } from "./agent-execution-dispatch-recovery.js"
import { enqueueOrRecoverAgentRunJob, type DispatchJobPayload, type DispatchJobQueue } from "./agent-execution-dispatch-job-recovery.js"
import type { AgentRunTaskPayload } from "./agent-run-queue.js"

const MAX_BATCH_SIZE = 50
const STALE_MS = LEGACY_RESUME_EXECUTION_STALE_MS
const RETRY_COOLDOWN_MS = 15_000
const RETRYABLE_OUTBOX_ROWS = new WeakMap<object, Map<string, number>>()
const SCAN_CURSORS = new WeakMap<object, string>()
const ACTIVE_TURNS = ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"]
const AUTHORIZATION_FAILURE = "Authorization was revoked before this agent run started."
const RETRY_EXHAUSTED_ERROR = "This agent run could not start after retrying. Please try again."
type Payload = { userId: string; sessionId: string; executionId: string; attemptCount: number; questionId: string }
type Row = { id: string; aggregateId: string; idempotencyKey: string; payload: unknown }
type Candidate = { payload: Payload; jobId: string; queueData: DispatchJobPayload; status: "queued" | "running"; currentAttemptCount: number }
type QuestionScope = { turnId: string } | { legacy: true }
type DbRow = Record<string, unknown>
type Pool = Pick<pg.Pool, "connect">

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function parsePayload(value: unknown): Payload | null {
  const row = asObject(value)
  if (!row || Object.keys(row).length !== 5) return null
  const { userId, sessionId, executionId, attemptCount, questionId } = row
  if (![userId, sessionId, executionId, questionId].every(item => typeof item === "string" && item.trim() === item && item.length > 0)) return null
  if (!Number.isSafeInteger(attemptCount) || (attemptCount as number) < 0) return null
  return { userId: userId as string, sessionId: sessionId as string, executionId: executionId as string, attemptCount: attemptCount as number, questionId: questionId as string }
}
function getQuestionScope(questionId: string): QuestionScope | null {
  const prefix = "agent-question:"
  if (!questionId.startsWith(prefix)) return { legacy: true }
  const suffix = questionId.slice(prefix.length)
  const split = suffix.indexOf(":")
  if (split < 1 || !suffix.slice(split + 1).startsWith("legacy:") || suffix.length <= split + 1 + "legacy:".length) return null
  return { turnId: suffix.slice(0, split) }
}
function expectedKey(payload: Payload): string {
  return `legacy-execution-dispatch:${payload.executionId}:${payload.attemptCount}:${payload.questionId}`
}
function activeTurn(status: unknown): boolean { return typeof status === "string" && ACTIVE_TURNS.includes(status) }
function staleRunning(row: DbRow, expectedAttempt: number, jobId: string, now: number): boolean {
  if (!Number.isFinite(STALE_MS) || STALE_MS <= 0 || expectedAttempt >= Number.MAX_SAFE_INTEGER) return false
  const updatedAt = row.updatedAt instanceof Date ? row.updatedAt.getTime() : new Date(String(row.updatedAt)).getTime()
  return row.status === "running" && row.workerTaskId === jobId && Number.isSafeInteger(row.attemptCount) &&
    (row.attemptCount as number) >= expectedAttempt + 1 && (row.attemptCount as number) < Number.MAX_SAFE_INTEGER &&
    Number.isFinite(updatedAt) && updatedAt < now - STALE_MS
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
  } finally { client.release() }
}
async function selectPublished(pool: LeasePool, afterId: string | null, limit: number): Promise<Row[]> {
  const client = await pool.connect()
  try {
    return (await client.query<Row>(`SELECT "id", "aggregateId", "idempotencyKey", "payload"
      FROM "agent_outbox" WHERE "topic" = $1 AND "publishedAt" IS NOT NULL
        AND ($2::text IS NULL OR "id" > $2) ORDER BY "id" LIMIT $3`,
    [AGENT_EXECUTION_DISPATCH_TOPIC, afterId, limit])).rows
  } finally { client.release() }
}
async function lockSession(client: pg.PoolClient, payload: Payload): Promise<DbRow | undefined> {
  return (await client.query<DbRow>(`SELECT "id", "userId", "status" FROM "agent_sessions"
    WHERE "id" = $1 FOR UPDATE`, [payload.sessionId])).rows[0]
}
async function prepare(pool: LeasePool, row: Row, payload: Payload, now: number): Promise<Candidate | null> {
  const scope = getQuestionScope(payload.questionId)
  if (!scope) return null
  const jobId = agentExecutionDispatchJobId(row.idempotencyKey)
  return transaction(pool, payload.userId, async client => {
    const session = await lockSession(client, payload)
    if (!session || session.userId !== payload.userId || session.status === "aborted" || session.status === "archived") return null
    let turn: DbRow | undefined
    let activeTurns: DbRow[] = []
    if ("turnId" in scope) {
      turn = (await client.query<DbRow>(`SELECT "id", "sessionId", "userId", "status" FROM "agent_turns"
        WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 FOR UPDATE`,
      [scope.turnId, payload.sessionId, payload.userId])).rows[0]
      if (!turn || !activeTurn(turn.status)) return null
    } else {
      activeTurns = (await client.query<DbRow>(`SELECT "id", "status" FROM "agent_turns"
        WHERE "sessionId" = $1 AND "userId" = $2 AND "status" = ANY($3::text[]) ORDER BY "id" FOR UPDATE`,
      [payload.sessionId, payload.userId, ACTIVE_TURNS])).rows
    }
    const question = (await client.query<DbRow>(`SELECT "id", "userId", "runId", "answer" FROM "AgentRunQuestion"
      WHERE "id" = $1 AND "userId" = $2 AND "runId" = $3 FOR UPDATE`,
    [payload.questionId, payload.userId, payload.sessionId])).rows[0]
    if (!question || question.answer === null || question.answer === undefined) return null
    const execution = (await client.query<DbRow>(`SELECT "id", "status", "attemptCount", "workerTaskId", "updatedAt"
      FROM "agent_executions" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 FOR UPDATE`,
    [payload.executionId, payload.sessionId, payload.userId])).rows[0]
    if (!execution || execution.workerTaskId !== jobId) return null
    const queued = execution.status === "queued" && execution.attemptCount === payload.attemptCount &&
      (!("turnId" in scope) || turn?.status === "waiting_for_user") && ("turnId" in scope || activeTurns.length === 0)
    const running = staleRunning(execution, payload.attemptCount, jobId, now) &&
      (!("turnId" in scope) || activeTurn(turn?.status)) && ("turnId" in scope || activeTurns.length <= 1)
    if (!queued && !running) return null
    const queueData: DispatchJobPayload = {
      ...payload,
      ...( "turnId" in scope ? { legacyTurnId: scope.turnId } : {}),
    }
    return { payload, jobId, queueData, status: queued ? "queued" : "running", currentAttemptCount: execution.attemptCount as number }
  })
}
function jobMatches(actual: AgentRunTaskPayload, expected: DispatchJobPayload): boolean {
  return actual.userId === expected.userId && actual.sessionId === expected.sessionId && actual.executionId === expected.executionId &&
    actual.attemptCount === expected.attemptCount && actual.questionId === expected.questionId &&
    actual.legacyTurnId === expected.legacyTurnId && actual.turnId === undefined
}
function pending(state: string): boolean {
  return ["waiting", "active", "delayed", "prioritized", "waiting-children"].includes(state)
}
function retryTimes(pool: LeasePool): Map<string, number> {
  const known = RETRYABLE_OUTBOX_ROWS.get(pool)
  if (known) return known
  const created = new Map<string, number>()
  RETRYABLE_OUTBOX_ROWS.set(pool, created)
  return created
}
function defer(pool: LeasePool, id: string, now: number): void {
  const times = retryTimes(pool)
  if (times.size >= 1_000 && !times.has(id)) {
    const oldest = times.keys().next().value as string | undefined
    if (oldest) times.delete(oldest)
  }
  times.set(id, now + RETRY_COOLDOWN_MS)
}
async function terminalize(pool: LeasePool, candidate: Candidate, reason: LegacyResumeFailureReason, now: number): Promise<boolean> {
  const staleBefore = candidate.status === "running" ? legacyResumeStaleBefore(now) ?? undefined : undefined
  const staleRunning = staleBefore === undefined
    ? undefined
    : { attemptCount: candidate.currentAttemptCount, staleBefore }
  if (candidate.queueData.legacyTurnId) {
    return failTurnScopedLegacyResume(pool, {
      ...candidate.payload,
      workerTaskId: candidate.jobId,
      legacyTurnId: candidate.queueData.legacyTurnId,
      reason,
      ...(staleRunning === undefined ? {} : { staleRunning }),
    })
  }
  if (candidate.status === "running" && (!Number.isFinite(STALE_MS) || STALE_MS <= 0 ||
    candidate.currentAttemptCount <= candidate.payload.attemptCount || candidate.currentAttemptCount >= Number.MAX_SAFE_INTEGER ||
    staleBefore === undefined || !Number.isFinite(staleBefore.getTime()))) return false
  if (candidate.status === "running" && reason === "authorization_revoked") {
    if (!staleBefore) return false
    return failStaleUnnamespacedLegacyResume(pool, {
      ...candidate.payload,
      workerTaskId: candidate.jobId,
      reason,
      staleBefore,
    })
  }
  return transaction(pool, candidate.payload.userId, async client => {
    const session = await lockSession(client, candidate.payload)
    if (!session || session.userId !== candidate.payload.userId || session.status === "aborted" || session.status === "archived") return false
    const activeTurns = await client.query<DbRow>(`SELECT "id" FROM "agent_turns"
      WHERE "sessionId" = $1 AND "userId" = $2 AND "status" = ANY($3::text[]) ORDER BY "id" FOR UPDATE`,
    [candidate.payload.sessionId, candidate.payload.userId, ACTIVE_TURNS])
    if (activeTurns.rows.length) return false
    const question = await client.query<DbRow>(`SELECT "id", "answer" FROM "AgentRunQuestion"
      WHERE "id" = $1 AND "userId" = $2 AND "runId" = $3 FOR UPDATE`,
    [candidate.payload.questionId, candidate.payload.userId, candidate.payload.sessionId])
    if (!question.rows[0] || question.rows[0].answer == null) return false
    const result = candidate.status === "running"
      ? await client.query(`UPDATE "agent_executions" SET "status" = 'failed', "error" = $7,
        "completedAt" = CURRENT_TIMESTAMP WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3
          AND "attemptCount" = $4 AND "workerTaskId" = $5 AND "status" = 'running' AND "updatedAt" < $6`,
      [candidate.payload.executionId, candidate.payload.userId, candidate.payload.sessionId, candidate.currentAttemptCount,
        candidate.jobId, staleBefore, reason === "authorization_revoked" ? AUTHORIZATION_FAILURE : RETRY_EXHAUSTED_ERROR])
      : await client.query(`UPDATE "agent_executions" SET "status" = 'failed', "error" = $6,
        "completedAt" = CURRENT_TIMESTAMP WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3
          AND "attemptCount" = $4 AND "workerTaskId" = $5 AND "status" = 'queued'`,
      [candidate.payload.executionId, candidate.payload.userId, candidate.payload.sessionId, candidate.payload.attemptCount,
        candidate.jobId, reason === "authorization_revoked" ? AUTHORIZATION_FAILURE : RETRY_EXHAUSTED_ERROR])
    return result.rowCount === 1
  })
}
async function recoverRow(pool: LeasePool, queue: DispatchJobQueue, row: Row, now: number): Promise<boolean> {
  const payload = parsePayload(row.payload)
  if (!payload || row.aggregateId !== payload.sessionId || row.idempotencyKey !== expectedKey(payload)) return false
  const candidate = await prepare(pool, row, payload, now)
  if (!candidate) return false
  const job = await queue.getJob(candidate.jobId)
  if (!job) {
    await enqueueOrRecoverAgentRunJob(queue, candidate.jobId, candidate.queueData)
    return true
  }
  if (!jobMatches(job.data, candidate.queueData)) return false
  const state = await job.getState()
  if (pending(state)) return false
  if (state !== "failed" && state !== "completed") return false
  const attempts = job.opts.attempts ?? 1
  if (state === "failed" && candidate.status === "queued" && job.attemptsMade >= attempts) {
    return await terminalize(pool, candidate, legacyResumeFailureReasonFromBull(job.failedReason) ?? "retry_exhausted", now)
  }
  if (state === "failed" && candidate.status === "running" && job.attemptsMade >= attempts) {
    return await terminalize(pool, candidate, legacyResumeFailureReasonFromBull(job.failedReason) ?? "retry_exhausted", now)
  }
  await enqueueOrRecoverAgentRunJob(queue, candidate.jobId, candidate.queueData)
  if (state === "completed") defer(pool, row.id, now)
  return true
}

/** Reconciles only published intents whose exact queue owner is still runnable or stale-running. */
export async function reconcilePublishedAgentExecutionDispatches(
  pool: LeasePool, queue: DispatchJobQueue, limit = MAX_BATCH_SIZE, now = Date.now(),
): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Agent execution published recovery limit must be positive")
  const bounded = Math.min(limit, MAX_BATCH_SIZE)
  let cursor = SCAN_CURSORS.get(pool) ?? null
  let rows = await selectPublished(pool, cursor, bounded)
  if (!rows.length && cursor !== null) {
    cursor = null
    rows = await selectPublished(pool, null, bounded)
  }
  if (rows.length) SCAN_CURSORS.set(pool, rows[rows.length - 1]?.id ?? cursor ?? "")
  else if (cursor === null) SCAN_CURSORS.delete(pool)
  let recovered = 0
  let firstError: unknown
  let failed = false
  for (const row of rows) {
    const times = retryTimes(pool)
    const retryAt = times.get(row.id)
    if (retryAt !== undefined && retryAt > now) continue
    times.delete(row.id)
    try {
      if (await recoverRow(pool, queue, row, now)) recovered += 1
    } catch (error: unknown) {
      defer(pool, row.id, now)
      if (!failed) { firstError = error; failed = true }
    }
  }
  if (failed) throw firstError
  return recovered
}
