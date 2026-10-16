import { randomUUID } from "node:crypto"
import type { Pool, PoolClient } from "pg"

export type ApplicationSubmitIdentity = Readonly<{
  sessionId: string
  fillTurnId: string
  applicationTaskId: string
  userId: string
  jobId: string
  approvalId: string
  constraintHash: string
}>
export type ApplicationSubmissionExecution = ApplicationSubmitIdentity & Readonly<{ workerTaskId: string; executionId: string }>
export type ExactAttemptFenceResult<T> = Readonly<{ kind: "current"; value: T }> | Readonly<{ kind: "superseded" }>

export class ApplicationSubmitFenceError extends Error {
  constructor(readonly code: "submission_scope_mismatch" | "submission_attempt_fenced", message: string) {
    super(message)
    this.name = "ApplicationSubmitFenceError"
  }
}

function validIdentity(identity: ApplicationSubmitIdentity): boolean {
  return [identity.sessionId, identity.fillTurnId, identity.applicationTaskId, identity.userId, identity.jobId, identity.approvalId]
    .every(value => typeof value === "string" && value.trim().length > 0) && /^[a-f0-9]{64}$/.test(identity.constraintHash)
}

/** Locks the shared recovery boundary before approval in the order used by recovery. */
export async function lockApplicationSubmitFence(client: PoolClient, identity: ApplicationSubmitIdentity): Promise<"current" | "superseded"> {
  if (!validIdentity(identity)) throw new ApplicationSubmitFenceError("submission_scope_mismatch", "Application submit identity is incomplete.")
  const session = await client.query(`SELECT "id" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2 FOR UPDATE`, [identity.sessionId, identity.userId])
  if (!session.rows[0]) throw new ApplicationSubmitFenceError("submission_scope_mismatch", "Application submit session is not owned by this user.")
  const turn = await client.query(`SELECT "id" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 FOR UPDATE`, [identity.fillTurnId, identity.sessionId, identity.userId])
  if (!turn.rows[0]) throw new ApplicationSubmitFenceError("submission_scope_mismatch", "Application submit Turn is not owned by this session.")
  const fillers = await client.query<{ id: string }>(
    `SELECT filler."id" FROM "sub_agent_tasks" AS filler INNER JOIN "agent_turns" AS scopedTurn ON scopedTurn."id" = filler."turnId" AND scopedTurn."sessionId" = filler."sessionId" AND scopedTurn."userId" = $3 WHERE filler."sessionId" = $1 AND filler."turnId" = $2 AND filler."role" = 'application_filler' AND filler."taskType" = 'application_fill_for_review' AND filler."status" = 'completed' AND filler."leaseOwner" IS NULL AND filler."leaseExpiresAt" IS NULL AND filler."interruptRequestedAt" IS NULL ORDER BY filler."id" FOR UPDATE OF filler`,
    [identity.sessionId, identity.fillTurnId, identity.userId],
  )
  if (fillers.rows.length !== 1) throw new ApplicationSubmitFenceError("submission_scope_mismatch", "Application submit filler task binding is missing or ambiguous.")
  const task = await client.query<{ sessionId: string | null; fillTurnId: string | null; fillTurnSessionId: string | null; fillTurnUserId: string | null }>(
    `SELECT "sessionId", "fillTurnId", "fillTurnSessionId", "fillTurnUserId" FROM "application_tasks" WHERE "id" = $1 AND "userId" = $2 AND "jobId" = $3 FOR UPDATE`,
    [identity.applicationTaskId, identity.userId, identity.jobId],
  )
  const row = task.rows[0]
  if (!row) throw new ApplicationSubmitFenceError("submission_scope_mismatch", "Application submit task is not owned by this user and job.")
  const job = await client.query<{ id: string }>(`SELECT "id" FROM "Job" WHERE "id" = $1 AND "userId" = $2 FOR UPDATE`, [identity.jobId, identity.userId])
  if (!job.rows[0]) throw new ApplicationSubmitFenceError("submission_scope_mismatch", "Application submit job is not owned by this user.")
  return row.sessionId === identity.sessionId && row.fillTurnId === identity.fillTurnId &&
    row.fillTurnSessionId === identity.sessionId && row.fillTurnUserId === identity.userId ? "current" : "superseded"
}

export async function withCurrentApplicationSubmit<T>(client: PoolClient, identity: ApplicationSubmitIdentity, work: () => Promise<T>): Promise<T | null> {
  const fenced = await withExactAttemptFence(client, identity, work)
  return fenced.kind === "current" ? fenced.value : null
}

/** Runs work under the caller's transaction after acquiring the shared recovery locks. */
export async function withExactAttemptFence<T>(client: PoolClient, identity: ApplicationSubmitIdentity, work: () => Promise<T>): Promise<ExactAttemptFenceResult<T>> {
  if (await lockApplicationSubmitFence(client, identity) === "superseded") return { kind: "superseded" }
  return { kind: "current", value: await work() }
}

/** Records a stale callback without changing application, job, or submission state. */
export async function appendFencedSubmitAudit(client: PoolClient, identity: ApplicationSubmitIdentity, phase: string): Promise<void> {
  const details = JSON.stringify({
    phase, sessionId: identity.sessionId, fillTurnId: identity.fillTurnId, applicationTaskId: identity.applicationTaskId,
    userId: identity.userId, jobId: identity.jobId, approvalId: identity.approvalId, constraintHash: identity.constraintHash,
  })
  await client.query(
    `INSERT INTO "application_task_events" ("id", "taskId", "type", "actor", "body", "data", "createdAt") SELECT $1, "id", 'submission_attempt_fenced', 'worker', $2, $3::jsonb, $4 FROM "application_tasks" WHERE "id" = $5 AND "userId" = $6 AND "jobId" = $7 AND "sessionId" = $8`,
    [randomUUID(), `Ignored superseded application submit ${phase} callback.`, details, new Date(), identity.applicationTaskId, identity.userId, identity.jobId, identity.sessionId],
  )
}

/** Persist terminal proof only for the invocation that atomically wrote its start event. */
export async function recordSubmissionExecutionSettled(pool: Pool, scope: ApplicationSubmissionExecution): Promise<boolean> {
  if (!validIdentity(scope) || !scope.workerTaskId.trim() || !scope.executionId.trim()) return false
  const client = await pool.connect()
  let transactionOpen = false
  try {
    await client.query("BEGIN"); transactionOpen = true
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", scope.userId])
    const fenced = await withExactAttemptFence(client, scope, async () => {
      const result = await client.query(
        `WITH starts AS (
          SELECT 1 FROM "application_task_events" WHERE "taskId" = $1 AND "type" = 'submission_execution_started'
            AND "actor" = 'worker' AND "data"->>'workerTaskId' = $2
        )
        INSERT INTO "application_task_events" ("id", "taskId", "type", "actor", "body", "data", "createdAt")
        SELECT $10, $1, 'submission_execution_settled', 'worker', 'Submit execution settled',
          jsonb_build_object('executionId', $3::text, 'workerTaskId', $2::text, 'applicationTaskId', $1::text, 'userId', $4::text,
            'jobId', $5::text, 'sessionId', $6::text, 'fillTurnId', $7::text, 'approvalId', $8::text, 'constraintHash', $9::text), NOW()
        WHERE (SELECT COUNT(*) FROM starts) = 1
          AND EXISTS (SELECT 1 FROM "application_task_events" WHERE "taskId" = $1 AND "type" = 'submission_execution_started'
            AND "actor" = 'worker' AND "data"->>'workerTaskId' = $2 AND "data"->>'executionId' = $3
            AND "data"->>'applicationTaskId' = $1 AND "data"->>'userId' = $4 AND "data"->>'jobId' = $5
            AND "data"->>'sessionId' = $6 AND "data"->>'fillTurnId' = $7 AND "data"->>'approvalId' = $8
            AND "data"->>'constraintHash' = $9)
          AND NOT EXISTS (SELECT 1 FROM "application_task_events" WHERE "taskId" = $1
            AND "type" = 'submission_execution_settled' AND "actor" = 'worker' AND "data"->>'workerTaskId' = $2)
        RETURNING "id"`,
        [scope.applicationTaskId, scope.workerTaskId, scope.executionId, scope.userId, scope.jobId,
          scope.sessionId, scope.fillTurnId, scope.approvalId, scope.constraintHash, `evt_${randomUUID()}`],
      )
      return result.rowCount === 1
    })
    if (fenced.kind === "superseded") await appendFencedSubmitAudit(client, scope, "submission_execution_settled")
    await client.query("COMMIT"); transactionOpen = false
    return fenced.kind === "current" && fenced.value
  } catch (error: unknown) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}
