import type { Queue } from "bullmq"
import type pg from "pg"
import type { AgentRunTaskPayload } from "./agent-run-queue.js"
import type { LeasePool } from "../runtime/turns/lease.js"
import {
  failTurnScopedLegacyResume,
  type LegacyResumeFailureReason,
} from "./agent-run-legacy-terminal-failure.js"

export type DispatchJobPayload = AgentRunTaskPayload & {
  executionId: string
  attemptCount: number
  questionId: string
  legacyTurnId?: string
}
export type DispatchJobQueue = Pick<Queue<AgentRunTaskPayload>, "add" | "getJob">
export type DispatchRecoveryResult = { kind: "runnable" } | { kind: "exhausted"; failedReason: string }
export type ExhaustedDispatchContext = {
  payload: DispatchJobPayload
  jobId: string
  legacyTurnId?: string
}

const RETRY_OPTIONS = { resetAttemptsMade: true, resetAttemptsStarted: true }
const ADD_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 60_000 },
  removeOnComplete: 100,
  removeOnFail: 200,
}
const ACTIVE_TURNS = ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"]
const AUTHORIZATION_FAILURE = "Authorization was revoked before this agent run started."
const RETRY_EXHAUSTED_FAILURE = "This agent run could not start after retrying. Please try again."

function matchesPayload(actual: AgentRunTaskPayload, expected: DispatchJobPayload): boolean {
  return actual.userId === expected.userId && actual.sessionId === expected.sessionId &&
    actual.executionId === expected.executionId && actual.attemptCount === expected.attemptCount &&
    actual.questionId === expected.questionId && actual.legacyTurnId === expected.legacyTurnId &&
    actual.turnId === undefined
}

function isPendingState(state: string): boolean {
  return state === "waiting" || state === "active" || state === "delayed" ||
    state === "prioritized" || state === "waiting-children"
}

/** Ensure the stable dispatch job is runnable, including after BullMQ retained it as failed. */
export async function enqueueOrRecoverAgentRunJob(
  queue: DispatchJobQueue,
  jobId: string,
  payload: DispatchJobPayload,
): Promise<DispatchRecoveryResult> {
  const existing = await queue.getJob(jobId)
  if (!existing) {
    await queue.add("run", payload, { jobId, ...ADD_OPTIONS })
    return { kind: "runnable" }
  }
  if (!matchesPayload(existing.data, payload)) {
    throw new Error("agent_execution_dispatch_job_scope_mismatch")
  }

  const state = await existing.getState()
  if (state === "failed" && existing.attemptsMade >= (existing.opts.attempts ?? 1)) {
    return { kind: "exhausted", failedReason: existing.failedReason }
  }
  if (state === "failed" || state === "completed") {
    try {
      await existing.retry(state, RETRY_OPTIONS)
    } catch (error: unknown) {
      // Another scanner may already have retried this job. Only a nonterminal
      // state proves that the stable job is again available or being claimed.
      const currentState = await existing.getState().catch(() => "unknown" as const)
      if (!isPendingState(currentState)) throw error
    }
    return { kind: "runnable" }
  }
  if (!isPendingState(state)) throw new Error("agent_execution_dispatch_job_state_unknown")
  return { kind: "runnable" }
}

async function userTransaction<T>(pool: LeasePool, userId: string, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", userId])
    const value = await work(client)
    await client.query("COMMIT")
    return value
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

/** Terminalize only the exact queued execution that owns an exhausted retained job. */
export async function terminalizeExhaustedAgentRunDispatch(
  pool: LeasePool,
  context: ExhaustedDispatchContext,
  reason: LegacyResumeFailureReason,
): Promise<boolean> {
  const { payload, jobId, legacyTurnId } = context
  if (legacyTurnId) {
    return failTurnScopedLegacyResume(pool, {
      userId: payload.userId,
      sessionId: payload.sessionId,
      executionId: payload.executionId,
      attemptCount: payload.attemptCount,
      workerTaskId: jobId,
      questionId: payload.questionId,
      legacyTurnId,
      reason,
    })
  }

  return userTransaction(pool, payload.userId, async client => {
    const session = await client.query<{ id: string; userId: string; status: string }>(`SELECT session."id", session."userId", session."status"
      FROM "agent_sessions" AS session WHERE session."id" = $1 AND session."userId" = $2 FOR UPDATE`, [payload.sessionId, payload.userId])
    if (!session.rows[0] || session.rows[0].status === "aborted" || session.rows[0].status === "archived") return false
    const activeTurns = await client.query<{ id: string }>(`SELECT turn."id" FROM "agent_turns" AS turn
      WHERE turn."sessionId" = $1 AND turn."userId" = $2 AND turn."status" = ANY($3::text[]) ORDER BY turn."id" FOR UPDATE`,
    [payload.sessionId, payload.userId, ACTIVE_TURNS])
    if (activeTurns.rows.length) return false
    const question = await client.query<{ id: string; answer: string | null }>(`SELECT question."id", question."answer" FROM "AgentRunQuestion" AS question
      WHERE question."id" = $1 AND question."userId" = $2 AND question."runId" = $3 FOR UPDATE`,
    [payload.questionId, payload.userId, payload.sessionId])
    if (!question.rows[0] || question.rows[0].answer == null) return false
    const error = reason === "authorization_revoked" ? AUTHORIZATION_FAILURE : RETRY_EXHAUSTED_FAILURE
    const failed = await client.query(`UPDATE "agent_executions" SET "status" = 'failed', "error" = $6,
      "completedAt" = CURRENT_TIMESTAMP WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3
        AND "attemptCount" = $4 AND "workerTaskId" = $5 AND "status" = 'queued'`,
    [payload.executionId, payload.userId, payload.sessionId, payload.attemptCount, jobId, error])
    return failed.rowCount === 1
  })
}
