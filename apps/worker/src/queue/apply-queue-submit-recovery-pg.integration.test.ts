import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool as PgPool, type PoolClient } from "pg"

import { markSubmissionRequestStarted } from "../db/application-task-state.js"
import { recordSubmissionExecutionSettled, withExactAttemptFence, type ApplicationSubmitIdentity, type ExactAttemptFenceResult } from "./application-submit-fence.js"

function disposableTestUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) {
    if (process.env.CI === "true" || process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true") {
      throw new Error("CI or AGENT_RUNTIME_PG_TEST_REQUIRED=true needs AGENT_RUNTIME_PG_TEST_URL")
    }
    return null
  }
  const url = new URL(value)
  const database = decodeURIComponent(url.pathname.slice(1))
  const expectedDatabase = process.env.CI === "true" ? "applymate_agent_brain_ci" : "applymate_submit_fence_845"
  if (url.protocol !== "postgresql:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
    || url.port !== "5432" || url.username !== "postgres" || database !== expectedDatabase
    || url.search !== "" || url.hash !== "" || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") {
    throw new Error("Application submit recovery integration requires an explicitly disposable loopback PostgreSQL database")
  }
  if (process.env.CI === "true" && process.env.AGENT_RUNTIME_PG_TEST_REQUIRED !== "true") {
    throw new Error("CI must set AGENT_RUNTIME_PG_TEST_REQUIRED=true for application submit recovery integration")
  }
  return value
}

const databaseUrl = disposableTestUrl()
const describeWithPostgres = databaseUrl ? describe : describe.skip
const schema = `submit_fence_${randomUUID().replaceAll("-", "")}`
const appPrefix = `submit_fence_${process.pid}_${randomUUID().slice(0, 8)}`
const pool = new PgPool({ connectionString: databaseUrl ?? "postgresql://postgres:postgres@127.0.0.1:5432/applymate_skip", max: 6, options: `-c search_path=${schema}` })

type Scenario = ApplicationSubmitIdentity & { readonly successorTurnId: string; readonly workerTaskId: string; readonly executionId: string }
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function waitForSignal(signal: Promise<void>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([signal, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 5_000) })])
  } finally { if (timer) clearTimeout(timer) }
}

async function waitUntilLockBlocked(applicationName: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await pool.query<{ state: string; wait_event_type: string | null }>(
      `SELECT state, wait_event_type FROM pg_stat_activity WHERE application_name = $1`, [applicationName],
    )
    if (result.rows[0]?.state === "active" && result.rows[0].wait_event_type === "Lock") return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`${applicationName} did not reach the expected PostgreSQL lock wait`)
}

async function connectClient(applicationName: string): Promise<PoolClient> {
  const client = await pool.connect()
  try {
    await client.query(`SET search_path TO "${schema}"`)
    await client.query("SELECT set_config('application_name', $1, false)", [applicationName])
    return client
  } catch (error) {
    client.release(true)
    throw error
  }
}

async function inTransaction<T>(applicationName: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await connectClient(applicationName)
  try {
    await client.query("BEGIN")
    const value = await work(client)
    await client.query("COMMIT")
    return value
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

async function seedScenario(label: string): Promise<Scenario> {
  const suffix = `${label}-${randomUUID()}`
  const identity: Scenario = {
    userId: `submit-user-${suffix}`, sessionId: `submit-session-${suffix}`, fillTurnId: `submit-turn-${suffix}`,
    successorTurnId: `submit-successor-${suffix}`, applicationTaskId: `submit-task-${suffix}`, jobId: `submit-job-${suffix}`,
    approvalId: `submit-receipt-${suffix}`, constraintHash: "c".repeat(64), workerTaskId: `bullmq-${suffix}`, executionId: randomUUID(),
  }
  await pool.query(`INSERT INTO "${schema}"."agent_sessions" ("id", "userId") VALUES ($1, $2)`, [identity.sessionId, identity.userId])
  await pool.query(`INSERT INTO "${schema}"."agent_turns" ("id", "sessionId", "userId") VALUES ($1, $2, $3), ($4, $2, $3)`, [
    identity.fillTurnId, identity.sessionId, identity.userId, identity.successorTurnId,
  ])
  await pool.query(`INSERT INTO "${schema}"."sub_agent_tasks" ("id", "sessionId", "turnId", "role", "taskType", "status") VALUES ($1, $2, $3, 'application_filler', 'application_fill_for_review', 'completed')`, [
    `filler-${suffix}`, identity.sessionId, identity.fillTurnId,
  ])
  await pool.query(`INSERT INTO "${schema}"."application_tasks" ("id", "userId", "jobId", "sessionId", "fillTurnId", "fillTurnSessionId", "fillTurnUserId", "status", "checkpoint", "workerTaskId") VALUES ($1, $2, $3, $4, $5, $4, $2, 'filling', 'submission_request_started', $6)`, [
    identity.applicationTaskId, identity.userId, identity.jobId, identity.sessionId, identity.fillTurnId, identity.workerTaskId,
  ])
  await pool.query(`INSERT INTO "${schema}"."Job" ("id", "userId") VALUES ($1, $2)`, [identity.jobId, identity.userId])
  await pool.query(`INSERT INTO "${schema}"."submission_attempt" ("id", "userId", "jobId", "receiptId", "constraintHash", "artifactHash", "state") VALUES ($1, $2, $3, $4, $5, $6, 'reserved')`, [
    `attempt-${suffix}`, identity.userId, identity.jobId, identity.approvalId, identity.constraintHash, "a".repeat(64),
  ])
  return identity
}

async function effectCount(identity: ApplicationSubmitIdentity): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM "${schema}"."submit_effects" WHERE "applicationTaskId" = $1`, [identity.applicationTaskId],
  )
  return result.rows[0]?.count ?? 0
}

async function boundTurn(identity: ApplicationSubmitIdentity): Promise<string | null> {
  const result = await pool.query<{ fillTurnId: string | null }>(
    `SELECT "fillTurnId" FROM "${schema}"."application_tasks" WHERE "id" = $1`, [identity.applicationTaskId],
  )
  return result.rows[0]?.fillTurnId ?? null
}

async function executionEvidenceSafe(identity: Scenario): Promise<boolean> {
  const result = await pool.query<{ safe: boolean }>(
    `SELECT COUNT(*) = 0 OR (COUNT(*) = 2 AND COUNT(*) FILTER (WHERE "type" = 'submission_execution_started') = 1
       AND COUNT(*) FILTER (WHERE "type" = 'submission_execution_settled') = 1
       AND COUNT(DISTINCT "data"->>'executionId') = 1
       AND COUNT(*) FILTER (WHERE "actor" = 'worker' AND "data"->>'applicationTaskId' = $2
         AND "data"->>'userId' = $3 AND "data"->>'jobId' = $4 AND "data"->>'sessionId' = $5
         AND "data"->>'fillTurnId' = $6 AND "data"->>'workerTaskId' = $7 AND "data"->>'approvalId' = $8
         AND "data"->>'constraintHash' = $9 AND "data"->>'executionId' <> '') = 2) AS safe
     FROM "application_task_events" WHERE "taskId" = $1
       AND "type" IN ('submission_execution_started', 'submission_execution_settled')
       AND ("data"->>'fillTurnId' = $6 OR "data"->>'workerTaskId' = $7)`,
    [identity.applicationTaskId, identity.applicationTaskId, identity.userId, identity.jobId, identity.sessionId,
      identity.fillTurnId, identity.workerTaskId, identity.approvalId, identity.constraintHash],
  )
  return result.rows[0]?.safe === true
}

describeWithPostgres("application submit recovery fence commit orders on disposable PostgreSQL", () => {
  let schemaCreated = false

  beforeAll(async () => {
    const client = await pool.connect()
    try {
      await client.query(`CREATE SCHEMA "${schema}"`)
      schemaCreated = true
      await client.query(`SET search_path TO "${schema}"`)
      await client.query(`CREATE TABLE "agent_sessions" ("id" text PRIMARY KEY, "userId" text NOT NULL)`)
      await client.query(`CREATE TABLE "agent_turns" ("id" text PRIMARY KEY, "sessionId" text NOT NULL, "userId" text NOT NULL)`)
      await client.query(`CREATE TABLE "sub_agent_tasks" (
        "id" text PRIMARY KEY, "sessionId" text NOT NULL, "turnId" text NOT NULL, "role" text NOT NULL,
        "taskType" text NOT NULL, "status" text NOT NULL, "leaseOwner" text, "leaseExpiresAt" timestamptz,
        "interruptRequestedAt" timestamptz
      )`)
      await client.query(`CREATE TABLE "application_tasks" (
        "id" text PRIMARY KEY, "userId" text NOT NULL, "jobId" text NOT NULL, "sessionId" text NOT NULL,
        "fillTurnId" text, "fillTurnSessionId" text, "fillTurnUserId" text,
        "status" text NOT NULL DEFAULT 'filling', "checkpoint" text NOT NULL DEFAULT 'submission_request_started', "workerTaskId" text
      )`)
      await client.query(`CREATE TABLE "application_task_events" (
        "id" text PRIMARY KEY, "taskId" text NOT NULL, "type" text NOT NULL, "actor" text NOT NULL,
        "body" text, "data" jsonb, "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`)
      await client.query(`CREATE TABLE "Job" (
        "id" text PRIMARY KEY, "userId" text NOT NULL, "status" text NOT NULL DEFAULT 'saved',
        "workflowState" text NOT NULL DEFAULT 'ready_to_apply', "appliedAt" timestamptz
      )`)
      await client.query(`CREATE TABLE "submit_effects" (
        "id" text PRIMARY KEY, "applicationTaskId" text NOT NULL, "fillTurnId" text NOT NULL, "result" text NOT NULL
      )`)
      await client.query(`CREATE TABLE "submission_attempt" (
        "id" text PRIMARY KEY, "userId" text NOT NULL, "jobId" text NOT NULL, "receiptId" text NOT NULL UNIQUE,
        "constraintHash" text NOT NULL, "artifactHash" text NOT NULL, "state" text NOT NULL,
        "responseRef" text, "errorCode" text, "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`)
    } finally { client.release() }
  })

  afterAll(async () => {
    try {
      if (schemaCreated) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } finally { await pool.end() }
  })

  it("accepts only a settled event from the invocation that atomically started submission", async () => {
    const identity = await seedScenario("execution-proof")
    const oldExecution = { executionId: randomUUID(), workerTaskId: "bullmq-prior", applicationTaskId: identity.applicationTaskId,
      userId: identity.userId, jobId: identity.jobId, sessionId: identity.sessionId, fillTurnId: "turn_prior",
      approvalId: "approval_prior", constraintHash: identity.constraintHash }
    await pool.query(`INSERT INTO "application_task_events" ("id", "taskId", type, actor, body, data)
      VALUES ($1, $2, 'submission_execution_started', 'worker', 'prior start', $3),
        ($4, $2, 'submission_execution_settled', 'worker', 'prior settled', $3)`,
      [`evt_${randomUUID()}`, identity.applicationTaskId, oldExecution, `evt_${randomUUID()}`])
    expect(await executionEvidenceSafe(identity)).toBe(true)
    await pool.query(`UPDATE "application_tasks" SET "workerTaskId" = NULL, "checkpoint" = 'browser_active' WHERE "id" = $1`, [identity.applicationTaskId])
    const start = await inTransaction(`${appPrefix}_execution_start`, client => withExactAttemptFence(client, identity, () =>
      markSubmissionRequestStarted(client, { ...identity, turnId: identity.fillTurnId })))
    expect(start).toEqual({ kind: "current", value: "started" })
    await pool.query(`UPDATE "application_tasks" SET "workerTaskId" = $2 WHERE "id" = $1`, [identity.applicationTaskId, identity.workerTaskId])
    expect(await executionEvidenceSafe(identity)).toBe(false)
    await expect(recordSubmissionExecutionSettled(pool, { ...identity, executionId: randomUUID() })).resolves.toBe(false)
    expect(await executionEvidenceSafe(identity)).toBe(false)
    await expect(recordSubmissionExecutionSettled(pool, identity)).resolves.toBe(true)
    expect(await executionEvidenceSafe(identity)).toBe(true)
  }, 15_000)

  it("returns superseded without a submit side effect when recovery commits the successor binding first", async () => {
    const identity = await seedScenario("recovery-first")
    const recoveryLocked = deferred()
    const allowRecoveryCommit = deferred()
    const recoveryApp = `${appPrefix}_recovery_first`
    const workerApp = `${appPrefix}_worker_late`
    let recovery: Promise<ExactAttemptFenceResult<string>> | undefined
    let worker: Promise<ExactAttemptFenceResult<void>> | undefined
    try {
      recovery = inTransaction(recoveryApp, client => withExactAttemptFence(client, identity, async () => {
        const update = await client.query(`UPDATE "application_tasks" SET "fillTurnId" = $1, "fillTurnSessionId" = $2, "fillTurnUserId" = $3 WHERE "id" = $4 AND "fillTurnId" = $5`, [
          identity.successorTurnId, identity.sessionId, identity.userId, identity.applicationTaskId, identity.fillTurnId,
        ])
        if (update.rowCount !== 1) throw new Error("Recovery did not bind the successor fill Turn")
        recoveryLocked.resolve()
        await allowRecoveryCommit.promise
        return "rebound"
      }))
      await waitForSignal(recoveryLocked.promise, "Recovery did not acquire the exact attempt fence")
      worker = inTransaction(workerApp, client => withExactAttemptFence(client, identity, async () => {
        await client.query(`INSERT INTO "submit_effects" ("id", "applicationTaskId", "fillTurnId", "result") VALUES ($1, $2, $3, 'late_submitted')`, [
          randomUUID(), identity.applicationTaskId, identity.fillTurnId,
        ])
      }))
      await waitUntilLockBlocked(workerApp)
      allowRecoveryCommit.resolve()
      await expect(recovery).resolves.toEqual({ kind: "current", value: "rebound" })
      await expect(worker).resolves.toEqual({ kind: "superseded" })
      expect(await boundTurn(identity)).toBe(identity.successorTurnId)
      expect(await effectCount(identity)).toBe(0)
    } finally {
      allowRecoveryCommit.resolve()
      const pending: Promise<unknown>[] = []
      if (recovery) pending.push(recovery)
      if (worker) pending.push(worker)
      await Promise.allSettled(pending)
    }
  }, 15_000)

  it("preserves a Worker result committed before recovery and refuses to rebind that attempt", async () => {
    const identity = await seedScenario("worker-first")
    const workerLocked = deferred()
    const allowWorkerCommit = deferred()
    const workerApp = `${appPrefix}_worker_first`
    const recoveryApp = `${appPrefix}_recovery_late`
    let worker: Promise<ExactAttemptFenceResult<string>> | undefined
    let recovery: Promise<ExactAttemptFenceResult<string>> | undefined
    try {
      worker = inTransaction(workerApp, client => withExactAttemptFence(client, identity, async () => {
        await client.query(`INSERT INTO "submit_effects" ("id", "applicationTaskId", "fillTurnId", "result") VALUES ($1, $2, $3, 'submitted')`, [
          randomUUID(), identity.applicationTaskId, identity.fillTurnId,
        ])
        await client.query(`UPDATE "Job" SET "status" = 'applied', "workflowState" = 'submitted', "appliedAt" = CURRENT_TIMESTAMP WHERE "id" = $1 AND "userId" = $2`, [identity.jobId, identity.userId])
        workerLocked.resolve()
        await allowWorkerCommit.promise
        return "submitted"
      }))
      await waitForSignal(workerLocked.promise, "Worker did not acquire the exact attempt fence")
      recovery = inTransaction(recoveryApp, client => withExactAttemptFence(client, identity, async () => {
        const job = await client.query<{ status: string; workflowState: string; appliedAt: Date | null }>(
          `SELECT "status", "workflowState", "appliedAt" FROM "Job" WHERE "id" = $1 AND "userId" = $2`, [identity.jobId, identity.userId],
        )
        const outcome = job.rows[0]
        if (!outcome || ["applied", "interview", "offer", "rejected"].includes(outcome.status)
          || outcome.workflowState === "submitted" || outcome.appliedAt !== null) return "already_submitted"
        await client.query(`UPDATE "application_tasks" SET "fillTurnId" = $1 WHERE "id" = $2`, [identity.successorTurnId, identity.applicationTaskId])
        return "rebound"
      }))
      await waitUntilLockBlocked(recoveryApp)
      allowWorkerCommit.resolve()
      await expect(worker).resolves.toEqual({ kind: "current", value: "submitted" })
      await expect(recovery).resolves.toEqual({ kind: "current", value: "already_submitted" })
      expect(await boundTurn(identity)).toBe(identity.fillTurnId)
      expect(await effectCount(identity)).toBe(1)
    } finally {
      allowWorkerCommit.resolve()
      const pending: Promise<unknown>[] = []
      if (worker) pending.push(worker)
      if (recovery) pending.push(recovery)
      await Promise.allSettled(pending)
    }
  }, 15_000)

  it("refuses recovery when the submission attempt committed before terminal Worker finalization", async () => {
    const identity = await seedScenario("attempt-commit-before-finalize")
    const claimApp = `${appPrefix}_attempt_claim`
    const submitApp = `${appPrefix}_attempt_submitted`
    const finalizeApp = `${appPrefix}_worker_finalize_crash`
    const recoveryApp = `${appPrefix}_recovery_after_attempt_commit`

    await inTransaction(claimApp, async client => {
      const result = await withExactAttemptFence(client, identity, async () => client.query(
        `UPDATE "Job" SET "workflowState" = 'submitting' WHERE "id" = $1 AND "userId" = $2 AND "workflowState" = 'ready_to_apply'`,
        [identity.jobId, identity.userId],
      ))
      expect(result.kind).toBe("current")
      expect(result.kind === "current" ? result.value.rowCount : 0).toBe(1)
    })

    await inTransaction(submitApp, async client => {
      const result = await withExactAttemptFence(client, identity, async () => client.query(
        `UPDATE "submission_attempt" SET "state" = 'submitted', "responseRef" = $1 WHERE "userId" = $2 AND "jobId" = $3 AND "receiptId" = $4 AND "constraintHash" = $5 AND "state" = 'reserved'`,
        [`application:${identity.applicationTaskId}`, identity.userId, identity.jobId, identity.approvalId, identity.constraintHash],
      ))
      expect(result.kind).toBe("current")
      expect(result.kind === "current" ? result.value.rowCount : 0).toBe(1)
    })

    // The browser submit is durable, but the queue task becomes terminal before
    // its separate Job/ApplicationTask success finalization can commit.
    await expect(inTransaction(finalizeApp, client => withExactAttemptFence(client, identity, async () => {
      await client.query(`UPDATE "Job" SET "status" = 'applied', "workflowState" = 'submitted', "appliedAt" = CURRENT_TIMESTAMP WHERE "id" = $1 AND "userId" = $2`, [identity.jobId, identity.userId])
      await client.query(`UPDATE "application_tasks" SET "status" = 'submitted', "checkpoint" = 'submission_verified' WHERE "id" = $1`, [identity.applicationTaskId])
      throw new Error("injected terminal BullMQ worker failure before finalization commit")
    }))).rejects.toThrow("injected terminal BullMQ worker failure")

    const recovery = await inTransaction(recoveryApp, async client => withExactAttemptFence(client, identity, async () => {
      const attempt = await client.query<{
        userId: string; jobId: string; receiptId: string; constraintHash: string; state: string
      }>(
        `SELECT "userId", "jobId", "receiptId", "constraintHash", "state" FROM "submission_attempt" WHERE "receiptId" = $1 FOR UPDATE`,
        [identity.approvalId],
      )
      const row = attempt.rows[0]
      if (!row || row.userId !== identity.userId || row.jobId !== identity.jobId || row.receiptId !== identity.approvalId
        || row.constraintHash !== identity.constraintHash || !["reserved", "failed"].includes(row.state)) return "refused" as const
      await client.query(`UPDATE "application_tasks" SET "fillTurnId" = $1 WHERE "id" = $2 AND "fillTurnId" = $3`, [
        identity.successorTurnId, identity.applicationTaskId, identity.fillTurnId,
      ])
      return "rebound" as const
    }))

    expect(recovery).toEqual({ kind: "current", value: "refused" })
    expect(await boundTurn(identity)).toBe(identity.fillTurnId)
    expect(await effectCount(identity)).toBe(0)
    const durableState = await pool.query<{ state: string; workflowState: string; taskStatus: string; checkpoint: string }>(
      `SELECT attempt."state", job."workflowState", task."status" AS "taskStatus", task."checkpoint"
         FROM "${schema}"."submission_attempt" attempt
         JOIN "${schema}"."Job" job ON job."id" = attempt."jobId"
         JOIN "${schema}"."application_tasks" task ON task."id" = $1
        WHERE attempt."receiptId" = $2`,
      [identity.applicationTaskId, identity.approvalId],
    )
    expect(durableState.rows[0]).toMatchObject({
      state: "submitted", workflowState: "submitting", taskStatus: "filling", checkpoint: "submission_request_started",
    })
  }, 15_000)
})
