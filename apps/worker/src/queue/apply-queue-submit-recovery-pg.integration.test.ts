import { createHash, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { Pool as PgPool, type Pool, type PoolClient } from "pg"
import { Queue, Worker } from "bullmq"
import { Redis } from "ioredis"
import type { ApplyTaskSubmitPayload } from "@jobcopilot/shared"

import { markSubmissionRequestStarted } from "../db/application-task-state.js"
import { claimUnattendedSubmission, reconcileClaimedSubmissionUncertain } from "../db/submission-guard.js"
import { APPLICATION_SUBMIT_OUTBOX_TOPIC, drainApplicationSubmitOutbox } from "./application-submit-outbox.js"
import { reconcileClaimedTerminalSubmit, reconcileTerminalSubmitJob, type SubmitOutboxIntent, type SubmitOutboxQueue } from "./application-submit-outbox-terminal-recovery.js"
import { recordSubmissionExecutionSettled, withExactAttemptFence, type ApplicationSubmitIdentity, type ExactAttemptFenceResult } from "./application-submit-fence.js"

function disposableTestUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true"
  if (process.env.CI === "true" && !required) return null
  if (!value) {
    if (required) throw new Error("AGENT_RUNTIME_PG_TEST_REQUIRED=true needs AGENT_RUNTIME_PG_TEST_URL")
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
  return value
}

const databaseUrl = disposableTestUrl()
const describeWithPostgres = databaseUrl ? describe : describe.skip
function disposableRedisTestUrl(): string | null {
  if (process.env.RUN_AGENT_TURN_REDIS_INTEGRATION !== "1") return null
  if (process.env.AGENT_TURN_REDIS_TEST_DISPOSABLE !== "true") {
    throw new Error("Application submit publisher integration requires an explicitly disposable Redis service")
  }
  const value = process.env.AGENT_TURN_REDIS_TEST_URL
  if (!value) throw new Error("AGENT_TURN_REDIS_TEST_URL is required when the Redis integration gate is enabled")
  const url = new URL(value)
  if (url.protocol !== "redis:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
    || url.port !== "6379" || url.pathname !== "/15" || url.username !== "" || url.password !== ""
    || url.search !== "" || url.hash !== "") {
    throw new Error("Application submit publisher integration accepts only a disposable loopback Redis DB 15 URL")
  }
  return value
}
const redisUrl = disposableRedisTestUrl()
const schema = `submit_fence_${randomUUID().replaceAll("-", "")}`
const appPrefix = `submit_fence_${process.pid}_${randomUUID().slice(0, 8)}`
const pool = new PgPool({ connectionString: databaseUrl ?? "postgresql://postgres:postgres@127.0.0.1:5432/applymate_skip", max: 6, options: `-c search_path=${schema}` })
let testRedis: Redis | undefined
let testQueueRedis: Redis | undefined
let submitQueue: Queue<ApplyTaskSubmitPayload> | undefined
const submitJobIds: string[] = []

type Scenario = ApplicationSubmitIdentity & { readonly successorTurnId: string; readonly workerTaskId: string; readonly executionId: string }
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function submitRecoverySnapshot(identity: ApplicationSubmitIdentity) {
  const task = await pool.query<{
    status: string; checkpoint: string; workerTaskId: string | null; error: string | null; updatedAt: Date
  }>(`SELECT "status", "checkpoint", "workerTaskId", "error", "updatedAt"
       FROM "${schema}"."application_tasks" WHERE "id" = $1`, [identity.applicationTaskId])
  const job = await pool.query<{
    status: string; workflowState: string; appliedAt: Date | null; updatedAt: Date
  }>(`SELECT "status", "workflowState", "appliedAt", "updatedAt"
       FROM "${schema}"."Job" WHERE "id" = $1`, [identity.jobId])
  const events = await pool.query<{
    id: string; type: string; actor: string; body: string | null; data: unknown; createdAt: Date
  }>(`SELECT "id", "type", "actor", "body", "data", "createdAt"
       FROM "${schema}"."application_task_events" WHERE "taskId" = $1 ORDER BY "id"`, [identity.applicationTaskId])
  return { task: task.rows[0] ?? null, job: job.rows[0] ?? null, events: events.rows }
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

function claimPool(applicationName: string): Pool {
  return {
    connect: async () => {
      const client = await pool.connect()
      await client.query("SELECT set_config('application_name', $1, false)", [applicationName])
      return client
    },
  } as unknown as Pool
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
  await pool.query(`INSERT INTO "${schema}"."application_tasks" ("id", "userId", "jobId", "sessionId", "fillTurnId", "fillTurnSessionId", "fillTurnUserId", "status", "checkpoint", "workerTaskId", "updatedAt") VALUES ($1, $2, $3, $4, $5, $4, $2, 'filling', 'submission_request_started', $6, NOW())`, [
    identity.applicationTaskId, identity.userId, identity.jobId, identity.sessionId, identity.fillTurnId, identity.workerTaskId,
  ])
  await pool.query(`INSERT INTO "${schema}"."Job" ("id", "userId") VALUES ($1, $2)`, [identity.jobId, identity.userId])
  await pool.query(`INSERT INTO "${schema}"."submission_attempt" ("id", "userId", "jobId", "receiptId", "constraintHash", "artifactHash", "state") VALUES ($1, $2, $3, $4, $5, $6, 'reserved')`, [
    `attempt-${suffix}`, identity.userId, identity.jobId, identity.approvalId, identity.constraintHash, "a".repeat(64),
  ])
  return identity
}

async function prepareSubmitClaim(identity: Scenario): Promise<void> {
  await pool.query(`INSERT INTO "${schema}"."User" ("id", "accountStatus") VALUES ($1, 'active')`, [identity.userId])
  await pool.query(`UPDATE "${schema}"."application_tasks" SET "status" = 'filling', "checkpoint" = 'submission_authorized', "workerTaskId" = $2 WHERE "id" = $1`, [
    identity.applicationTaskId, identity.workerTaskId,
  ])
  await pool.query(`UPDATE "${schema}"."Job" SET "status" = 'saved', "workflowState" = 'queued' WHERE "id" = $1`, [identity.jobId])
  await pool.query(`INSERT INTO "${schema}"."agent_approvals"
    ("id", "userId", "sessionId", "turnId", "taskId", "jobId", "type", "toolCallId", "status", "scopeHash", "expiresAt", "payload")
    VALUES ($1, $2, $3, $4, $5, $6, 'submit_application', 'application-submit:' || $5, 'approved', $7, NOW() + INTERVAL '1 hour', $8::jsonb)`, [
    identity.approvalId, identity.userId, identity.sessionId, identity.fillTurnId, identity.applicationTaskId, identity.jobId,
    identity.constraintHash, JSON.stringify({ applicationTaskId: identity.applicationTaskId, jobId: identity.jobId }),
  ])
}

async function prepareOutboxedSubmit(label: string) {
  const seeded = await seedScenario(label)
  const digest = createHash("sha256").update(JSON.stringify([seeded.applicationTaskId, seeded.fillTurnId, seeded.approvalId])).digest("hex")
  const identity: Scenario = { ...seeded, workerTaskId: `apply-submit-${digest}` }
  const submitPayload: ApplyTaskSubmitPayload = {
    applicationTaskId: identity.applicationTaskId, userId: identity.userId, jobId: identity.jobId,
    sessionId: identity.sessionId, fillTurnId: identity.fillTurnId, receiptId: identity.approvalId,
    constraintHash: identity.constraintHash, operation: "submit", applyUrl: `https://jobs.example/${label}`,
    personaId: "server-side", resumePath: "",
  }
  const outbox = {
    id: `application-submit-outbox-${digest}`, topic: APPLICATION_SUBMIT_OUTBOX_TOPIC,
    aggregateId: identity.sessionId, idempotencyKey: `application-submit:${digest}`,
    payload: {
      applicationTaskId: identity.applicationTaskId, userId: identity.userId, jobId: identity.jobId,
      sessionId: identity.sessionId, fillTurnId: identity.fillTurnId, receiptId: identity.approvalId,
      constraintHash: identity.constraintHash, workerTaskId: identity.workerTaskId, submitPayload,
    },
  }
  await prepareSubmitClaim(identity)
  const event = {
    applicationTaskId: identity.applicationTaskId, userId: identity.userId, jobId: identity.jobId,
    sessionId: identity.sessionId, fillTurnId: identity.fillTurnId, approvalId: identity.approvalId,
    receiptId: identity.approvalId, constraintHash: identity.constraintHash, workerTaskId: identity.workerTaskId,
  }
  await pool.query(`INSERT INTO "${schema}"."application_task_events" ("id", "taskId", "type", "actor", "body", "data")
    VALUES ($1, $2, 'submission_queued', 'user', 'User approved this job for background submission.', $3::jsonb)`, [
    `queued-${label}-${randomUUID()}`, identity.applicationTaskId, JSON.stringify(event),
  ])
  await pool.query(`INSERT INTO "${schema}"."agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
    VALUES ($1, $2, $3, $4, $5::jsonb)`, [outbox.id, outbox.topic, outbox.aggregateId, outbox.idempotencyKey, JSON.stringify(outbox.payload)])
  submitJobIds.push(identity.workerTaskId)
  return { identity, submitPayload, outboxId: outbox.id }
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
      await client.query(`CREATE TABLE "agent_sessions" (
        "id" text PRIMARY KEY, "userId" text NOT NULL, "status" text NOT NULL DEFAULT 'running',
        "completedAt" timestamptz, "updatedAt" timestamptz
      )`)
      await client.query(`CREATE TABLE "agent_turns" ("id" text PRIMARY KEY, "sessionId" text NOT NULL, "userId" text NOT NULL)`)
      await client.query(`CREATE TABLE "sub_agent_tasks" (
        "id" text PRIMARY KEY, "sessionId" text NOT NULL, "turnId" text NOT NULL, "role" text NOT NULL,
        "taskType" text NOT NULL, "status" text NOT NULL, "leaseOwner" text, "leaseExpiresAt" timestamptz,
        "interruptRequestedAt" timestamptz
      )`)
      await client.query(`CREATE TABLE "application_tasks" (
        "id" text PRIMARY KEY, "userId" text NOT NULL, "jobId" text NOT NULL, "sessionId" text NOT NULL,
        "fillTurnId" text, "fillTurnSessionId" text, "fillTurnUserId" text,
        "status" text NOT NULL DEFAULT 'filling', "checkpoint" text NOT NULL DEFAULT 'submission_request_started', "workerTaskId" text, "error" text,
        "updatedAt" TIMESTAMP(3) NOT NULL
      )`)
      await client.query(`CREATE TABLE "application_task_events" (
        "id" text PRIMARY KEY, "taskId" text NOT NULL, "type" text NOT NULL, "actor" text NOT NULL,
        "body" text, "data" jsonb, "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`)
      await client.query(`CREATE TABLE "Job" (
        "id" text PRIMARY KEY, "userId" text NOT NULL, "status" text NOT NULL DEFAULT 'saved',
        "workflowState" text NOT NULL DEFAULT 'ready_to_apply', "appliedAt" timestamptz,
        "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`)
      await client.query(`CREATE TABLE "User" ("id" text PRIMARY KEY, "accountStatus" text NOT NULL)`)
      await client.query(`CREATE TABLE "agent_approvals" (
        "id" text PRIMARY KEY, "userId" text NOT NULL, "sessionId" text NOT NULL, "turnId" text NOT NULL,
        "taskId" text NOT NULL, "jobId" text NOT NULL, "type" text NOT NULL, "toolCallId" text NOT NULL,
        "status" text NOT NULL, "scopeHash" text NOT NULL, "expiresAt" timestamptz NOT NULL, "payload" jsonb NOT NULL
      )`)
      await client.query(`CREATE FUNCTION "${schema}"."pause_submit_claim"() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(845, 84510); RETURN NEW; END $$`)
      await client.query(`CREATE TRIGGER "pause_submit_claim" BEFORE UPDATE ON "application_tasks" FOR EACH ROW
        WHEN (NEW."checkpoint" = 'browser_active') EXECUTE FUNCTION "${schema}"."pause_submit_claim"()`)
      await client.query(`CREATE TABLE "submit_effects" (
        "id" text PRIMARY KEY, "applicationTaskId" text NOT NULL, "fillTurnId" text NOT NULL, "result" text NOT NULL
      )`)
      await client.query(`CREATE TABLE "submission_attempt" (
        "id" text PRIMARY KEY, "userId" text NOT NULL, "jobId" text NOT NULL, "receiptId" text NOT NULL UNIQUE,
        "constraintHash" text NOT NULL, "artifactHash" text NOT NULL, "state" text NOT NULL,
        "responseRef" text, "errorCode" text, "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`)
      await client.query(`CREATE TABLE "agent_outbox" (
        "id" text PRIMARY KEY, "topic" text NOT NULL, "aggregateId" text NOT NULL, "idempotencyKey" text NOT NULL UNIQUE,
        "payload" jsonb NOT NULL, "attemptCount" integer NOT NULL DEFAULT 0, "publishedAt" timestamptz, "lastError" text
      )`)
    } finally { client.release() }
  })

  beforeAll(async () => {
    if (!redisUrl) return
    testRedis = new Redis(redisUrl, {
      lazyConnect: true, maxRetriesPerRequest: null, enableReadyCheck: false, connectTimeout: 2_000,
      retryStrategy: attempt => attempt > 3 ? null : 100,
    })
    await testRedis.connect()
    await testRedis.ping()
    testQueueRedis = testRedis.duplicate()
    submitQueue = new Queue<ApplyTaskSubmitPayload>("apply-tasks", { connection: testQueueRedis })
    await submitQueue.waitUntilReady()
  }, 15_000)

  afterAll(async () => {
    try {
      for (const id of submitJobIds) {
        const job = await submitQueue?.getJob(id).catch(() => undefined)
        if (!job) continue
        if (await job.getState().catch(() => "unknown") !== "active") await job.remove().catch(() => undefined)
      }
      await submitQueue?.close().catch(() => undefined)
      await testQueueRedis?.quit().catch(() => undefined)
      if (testRedis && testRedis.status !== "end") await testRedis.quit().catch(() => testRedis?.disconnect())
      if (schemaCreated) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } finally { await pool.end() }
  })

  it.skipIf(!redisUrl)("rejects a real Redis publish when recovery binds a successor first", async () => {
    const { identity, outboxId } = await prepareOutboxedSubmit("publisher-recovery-first")
    const recoveryLocked = deferred()
    const allowRecoveryCommit = deferred()
    const recoveryApp = `${appPrefix}_recovery_before_publish`
    const publisherApp = `${appPrefix}_publisher_after_recovery`
    let recovery: Promise<ExactAttemptFenceResult<string>> | undefined
    let publishing: Promise<number> | undefined
    const add = vi.spyOn(submitQueue!, "add")
    try {
      recovery = inTransaction(recoveryApp, client => withExactAttemptFence(client, identity, async () => {
        const task = await client.query(`UPDATE "application_tasks" SET "status" = 'waiting_for_user', "checkpoint" = 'submission_uncertain',
            "fillTurnId" = $1, "fillTurnSessionId" = $2, "fillTurnUserId" = $3
          WHERE "id" = $4 AND "fillTurnId" = $5 RETURNING "id"`, [
          identity.successorTurnId, identity.sessionId, identity.userId, identity.applicationTaskId, identity.fillTurnId,
        ])
        if (task.rowCount !== 1) throw new Error("Recovery did not bind the successor fill Turn")
        await client.query(`UPDATE "Job" SET "workflowState" = 'submitting' WHERE "id" = $1 AND "userId" = $2`, [identity.jobId, identity.userId])
        recoveryLocked.resolve()
        await allowRecoveryCommit.promise
        return "rebound"
      }))
      await waitForSignal(recoveryLocked.promise, "Recovery did not acquire the exact submit fence")

      publishing = drainApplicationSubmitOutbox(
        claimPool(publisherApp), submitQueue as unknown as SubmitOutboxQueue,
      )
      await waitUntilLockBlocked(publisherApp)
      allowRecoveryCommit.resolve()

      await expect(recovery).resolves.toEqual({ kind: "current", value: "rebound" })
      await expect(publishing).resolves.toBe(0)
      expect(add).not.toHaveBeenCalled()
      await expect(submitQueue!.getJob(identity.workerTaskId)).resolves.toBeUndefined()
      const outbox = await pool.query<{ publishedAt: Date | null; lastError: string | null }>(
        `SELECT "publishedAt", "lastError" FROM "${schema}"."agent_outbox" WHERE "id" = $1`, [outboxId],
      )
      expect(outbox.rows[0]).toMatchObject({ publishedAt: null, lastError: "terminal:attempt_superseded" })
    } finally {
      allowRecoveryCommit.resolve()
      const pending: Promise<unknown>[] = []
      if (recovery) pending.push(recovery)
      if (publishing) pending.push(publishing)
      await Promise.allSettled(pending)
      add.mockRestore()
    }
  }, 20_000)

  it.skipIf(!redisUrl)("publishes under the fence first so recovery can inspect and cancel that exact Redis job", async () => {
    const { identity, outboxId, submitPayload } = await prepareOutboxedSubmit("publisher-before-recovery")
    const addReached = deferred()
    const allowAdd = deferred()
    const originalAdd = submitQueue!.add.bind(submitQueue!)
    const gatedQueue = new Proxy(submitQueue!, {
      get(target, property) {
        if (property === "add") return async (name: string, data: ApplyTaskSubmitPayload, options: { jobId: string }) => {
          addReached.resolve()
          await allowAdd.promise
          return originalAdd(name, data, options)
        }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === "function" ? value.bind(target) : value
      },
    }) as unknown as SubmitOutboxQueue
    const publisherApp = `${appPrefix}_publisher_before_recovery`
    const recoveryApp = `${appPrefix}_recovery_after_publish`
    let publishing: Promise<number> | undefined
    let recovery: Promise<ExactAttemptFenceResult<string>> | undefined
    try {
      publishing = drainApplicationSubmitOutbox(claimPool(publisherApp), gatedQueue)
      await waitForSignal(addReached.promise, "Publisher did not reach Queue.add while holding the submit fence")
      recovery = inTransaction(recoveryApp, client => withExactAttemptFence(client, identity, async () => {
        const id = identity.workerTaskId
        const job = await submitQueue!.getJob(id)
        if (!job || job.id !== id) {
          throw new Error("Recovery could not inspect the exact published submit job")
        }
        expect(job.data).toEqual(submitPayload)
        if (await job.getState() !== "waiting") throw new Error("The exact submit job was not pending at recovery")
        await job.remove()
        if (await submitQueue!.getJob(id)) throw new Error("The exact submit job remained after recovery cancellation")
        if (await (await submitQueue!.client).get(submitQueue!.toKey(`${id}:lock`)) !== null) {
          throw new Error("The exact submit job lock remained after recovery cancellation")
        }
        const task = await client.query(`UPDATE "application_tasks" SET "status" = 'waiting_for_user', "checkpoint" = 'submission_uncertain',
            "fillTurnId" = $1, "fillTurnSessionId" = $2, "fillTurnUserId" = $3
          WHERE "id" = $4 AND "fillTurnId" = $5 RETURNING "id"`, [
          identity.successorTurnId, identity.sessionId, identity.userId, identity.applicationTaskId, identity.fillTurnId,
        ])
        if (task.rowCount !== 1) throw new Error("Recovery did not bind the successor fill Turn")
        await client.query(`UPDATE "Job" SET "workflowState" = 'submitting' WHERE "id" = $1 AND "userId" = $2`, [identity.jobId, identity.userId])
        return "rebound"
      }))
      await waitUntilLockBlocked(recoveryApp)
      allowAdd.resolve()

      await expect(publishing).resolves.toBe(1)
      await expect(recovery).resolves.toEqual({ kind: "current", value: "rebound" })
      expect(await submitQueue!.getJob(identity.workerTaskId)).toBeUndefined()
      const outbox = await pool.query<{ publishedAt: Date | null; lastError: string | null }>(
        `SELECT "publishedAt", "lastError" FROM "${schema}"."agent_outbox" WHERE "id" = $1`, [outboxId],
      )
      expect(outbox.rows[0]?.publishedAt).toBeInstanceOf(Date)
      expect(outbox.rows[0]?.lastError).toBeNull()
    } finally {
      allowAdd.resolve()
      const pending: Promise<unknown>[] = []
      if (publishing) pending.push(publishing)
      if (recovery) pending.push(recovery)
      await Promise.allSettled(pending)
    }
  }, 20_000)

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

  it("atomically claims one exact submit delivery before browser setup and leaves its Job submitting", async () => {
    const identity = await seedScenario("concurrent-submit-claim")
    await prepareSubmitClaim(identity)

    const blocker = await connectClient(`${appPrefix}_claim_blocker`)
    const firstApp = `${appPrefix}_claim_first`
    const secondApp = `${appPrefix}_claim_second`
    let first: Promise<string> | undefined
    let second: Promise<string> | undefined
    try {
      await blocker.query("SELECT pg_advisory_lock(845, 84510)")
      first = claimUnattendedSubmission(claimPool(firstApp), identity, identity.workerTaskId)
      await waitUntilLockBlocked(firstApp)
      second = claimUnattendedSubmission(claimPool(secondApp), identity, identity.workerTaskId)
      await waitUntilLockBlocked(secondApp)
      await blocker.query("SELECT pg_advisory_unlock(845, 84510)")

      await expect(first).resolves.toBe("claimed")
      await expect(second).resolves.toBe("unavailable")
      const durable = await pool.query<{ taskStatus: string; checkpoint: string; workerTaskId: string; status: string; workflowState: string }>(
        `SELECT task."status" AS "taskStatus", task."checkpoint", task."workerTaskId", job."status", job."workflowState"
           FROM "${schema}"."application_tasks" task JOIN "${schema}"."Job" job ON job."id" = task."jobId"
          WHERE task."id" = $1`, [identity.applicationTaskId],
      )
      expect(durable.rows[0]).toEqual({
        taskStatus: "filling", checkpoint: "browser_active", workerTaskId: identity.workerTaskId,
        status: "saved", workflowState: "submitting",
      })
    } finally {
      await blocker.query("SELECT pg_advisory_unlock(845, 84510)").catch(() => undefined)
      blocker.release()
      await Promise.allSettled([first, second].filter((claim): claim is Promise<string> => claim !== undefined))
    }
  }, 15_000)

  it.skipIf(!redisUrl)("does not reconcile a terminal preflight after the same BullMQ delivery is retried and claimed", async () => {
    const identity = await seedScenario("stale-terminal-after-retry-claim")
    await prepareSubmitClaim(identity)
    const submitPayload: ApplyTaskSubmitPayload = {
      applicationTaskId: identity.applicationTaskId, userId: identity.userId, jobId: identity.jobId,
      sessionId: identity.sessionId, fillTurnId: identity.fillTurnId, receiptId: identity.approvalId,
      constraintHash: identity.constraintHash, operation: "submit", applyUrl: "https://jobs.example/retried-submit",
      personaId: "server-side", resumePath: "",
    }
    const workerTaskId = identity.workerTaskId
    const queueName = `apply-submit-recovery-${randomUUID()}`
    const queueRedis = testRedis!.duplicate()
    const firstWorkerRedis = testRedis!.duplicate()
    const retryWorkerRedis = testRedis!.duplicate()
    const queue = new Queue<ApplyTaskSubmitPayload>(queueName, { connection: queueRedis })
    const terminalFailure = deferred()
    const activeClaimReached = deferred()
    const holdRetryProcessor = deferred()
    const poolConnectionRequested = deferred()
    const allowPoolConnection = deferred()
    let staleTerminalEvent: { readonly id: string; readonly payload: ApplyTaskSubmitPayload; readonly attemptsMade: number } | undefined
    let activeClaim: string | undefined
    let firstWorker: Worker<ApplyTaskSubmitPayload, void> | undefined
    let retryWorker: Worker<ApplyTaskSubmitPayload, void> | undefined
    let firstWorkerClosed = false
    let recovery: Promise<Awaited<ReturnType<typeof reconcileClaimedTerminalSubmit>>> | undefined

    try {
      await queue.waitUntilReady()
      firstWorker = new Worker<ApplyTaskSubmitPayload, void>(queueName, async () => {
        throw new Error("injected pre-claim Worker failure")
      }, { connection: firstWorkerRedis, concurrency: 1 })
      firstWorker.on("failed", job => {
        if (!job || job.id !== workerTaskId) return
        staleTerminalEvent = { id: job.id, payload: structuredClone(job.data), attemptsMade: job.attemptsMade }
        terminalFailure.resolve()
      })
      await firstWorker.waitUntilReady()
      await queue.add("submit", submitPayload, {
        jobId: workerTaskId, attempts: 1, removeOnComplete: false, removeOnFail: false,
      })
      await waitForSignal(terminalFailure.promise, "Initial BullMQ delivery did not reach terminal failure")
      await firstWorker.close()
      firstWorkerClosed = true

      const terminalJob = await queue.getJob(workerTaskId)
      expect(terminalJob?.id).toBe(workerTaskId)
      expect(terminalJob?.data).toEqual(submitPayload)
      expect(await terminalJob?.getState()).toBe("failed")
      const staleEvent = staleTerminalEvent
      if (!staleEvent) throw new Error("The failed delivery did not produce a terminal event identity")
      expect(staleEvent.attemptsMade).toBe(1)

      const intent: SubmitOutboxIntent = {
        applicationTaskId: identity.applicationTaskId, userId: identity.userId, jobId: identity.jobId,
        sessionId: identity.sessionId, fillTurnId: identity.fillTurnId, receiptId: identity.approvalId,
        constraintHash: identity.constraintHash, workerTaskId, submitPayload,
      }
      const gatedPool = {
        connect: async () => {
          poolConnectionRequested.resolve()
          await allowPoolConnection.promise
          return claimPool(`${appPrefix}_stale_terminal_after_retry`).connect()
        },
      } as unknown as Pool
      recovery = reconcileClaimedTerminalSubmit(gatedPool, queue as unknown as SubmitOutboxQueue, intent)
      await waitForSignal(poolConnectionRequested.promise, "Terminal delivery preflight did not reach the database fence")
      expect(await (await queue.getJob(workerTaskId))?.getState()).toBe("failed")

      await terminalJob!.retry("failed", { resetAttemptsMade: true, resetAttemptsStarted: true })
      expect(await (await queue.getJob(workerTaskId))?.getState()).toBe("waiting")

      retryWorker = new Worker<ApplyTaskSubmitPayload, void>(queueName, async job => {
        if (job.id !== workerTaskId) throw new Error("Retry Worker received a different submit delivery")
        activeClaim = await claimUnattendedSubmission(pool, identity, job.id)
        activeClaimReached.resolve()
        await holdRetryProcessor.promise
      }, { connection: retryWorkerRedis, concurrency: 1 })
      await retryWorker.waitUntilReady()
      await waitForSignal(activeClaimReached.promise, "Retried BullMQ delivery did not reach its fenced claim")
      expect(activeClaim).toBe("claimed")

      const activeJob = await queue.getJob(workerTaskId)
      expect(activeJob?.id).toBe(staleEvent.id)
      expect(activeJob?.data).toEqual(staleEvent.payload)
      expect(await activeJob?.getState()).toBe("active")
      const lockKey = queue.toKey(`${staleEvent.id}:lock`)
      expect(await (await queue.client).get(lockKey)).not.toBeNull()

      const beforeRecovery = await submitRecoverySnapshot(identity)
      expect(beforeRecovery.task).toMatchObject({ status: "filling", checkpoint: "browser_active", workerTaskId })
      expect(beforeRecovery.job).toMatchObject({ status: "saved", workflowState: "submitting", appliedAt: null })

      allowPoolConnection.resolve()
      await expect(recovery).resolves.toBe("deferred")
      expect(await submitRecoverySnapshot(identity)).toEqual(beforeRecovery)
      expect(await (await queue.getJob(workerTaskId))?.getState()).toBe("active")
      expect(await (await queue.client).get(lockKey)).not.toBeNull()
    } finally {
      allowPoolConnection.resolve()
      holdRetryProcessor.resolve()
      const pending: Promise<unknown>[] = []
      if (recovery) pending.push(recovery)
      if (firstWorker && !firstWorkerClosed) pending.push(firstWorker.close())
      if (retryWorker) pending.push(retryWorker.close())
      await Promise.allSettled(pending)
      const remaining = await queue.getJob(workerTaskId).catch(() => undefined)
      if (remaining && await remaining.getState().catch(() => "unknown") !== "active") await remaining.remove().catch(() => undefined)
      await queue.obliterate({ force: true }).catch(() => undefined)
      await queue.close().catch(() => undefined)
      for (const connection of [firstWorkerRedis, retryWorkerRedis, queueRedis]) {
        if (connection.status !== "end") await connection.quit().catch(() => connection.disconnect())
      }
    }
  }, 30_000)

  it.skipIf(!redisUrl)("keeps a pruned claimed job blocked without Worker terminal evidence", async () => {
    const { identity } = await prepareOutboxedSubmit("claimed-terminal-job-pruned-without-proof")
    await expect(drainApplicationSubmitOutbox(pool, submitQueue as unknown as SubmitOutboxQueue)).resolves.toBe(1)
    await expect(claimUnattendedSubmission(pool, identity, identity.workerTaskId)).resolves.toBe("claimed")
    const waiting = await submitQueue!.getJob(identity.workerTaskId)
    expect(await waiting?.getState()).toBe("waiting")
    await waiting!.remove()
    await expect(drainApplicationSubmitOutbox(pool, submitQueue as unknown as SubmitOutboxQueue)).resolves.toBe(0)
    const unchanged = await submitRecoverySnapshot(identity)
    expect(unchanged.task).toMatchObject({ status: "filling", checkpoint: "browser_active", workerTaskId: identity.workerTaskId })
    expect(unchanged.events.filter(event => event.type === "submission_terminal_observed")).toHaveLength(0)
  }, 20_000)

  it.skipIf(!redisUrl)("retries failed terminal-proof persistence from retained delivery before pruning", async () => {
    const { identity, outboxId } = await prepareOutboxedSubmit("claimed-terminal-proof-retry")
    const completed = deferred()
    let workerRedis: Redis | undefined
    let worker: Worker<ApplyTaskSubmitPayload, void> | undefined
    try {
      await expect(drainApplicationSubmitOutbox(pool, submitQueue as unknown as SubmitOutboxQueue)).resolves.toBe(1)
      await expect(claimUnattendedSubmission(pool, identity, identity.workerTaskId)).resolves.toBe("claimed")

      // Simulate Worker exit after its durable claim, before application-state finalization.
      workerRedis = testRedis!.duplicate()
      worker = new Worker<ApplyTaskSubmitPayload, void>("apply-tasks", async job => {
        if (job.id !== identity.workerTaskId) throw new Error("Terminal test Worker received a different submit job")
      }, { connection: workerRedis, concurrency: 1 })
      worker.on("completed", job => { if (job?.id === identity.workerTaskId) completed.resolve() })
      await worker.waitUntilReady()
      await waitForSignal(completed.promise, "Claimed submit delivery did not complete before pruning")
      await worker.close()
      worker = undefined

      const terminalJob = await submitQueue!.getJob(identity.workerTaskId)
      expect(await terminalJob?.getState()).toBe("completed")
      expect(terminalJob?.opts.removeOnComplete).toBe(false)
      expect(terminalJob?.opts.removeOnFail).toBe(false)
      const lockKey = submitQueue!.toKey(`${identity.workerTaskId}:lock`)
      expect(await (await submitQueue!.client).get(lockKey)).toBeNull()

      await pool.query(`CREATE FUNCTION "${schema}"."reject_terminal_proof"() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW."type" = 'submission_terminal_observed' THEN RAISE EXCEPTION 'injected terminal proof write failure'; END IF; RETURN NEW; END $$`)
      await pool.query(`CREATE TRIGGER "reject_terminal_proof" BEFORE INSERT ON "${schema}"."application_task_events"
        FOR EACH ROW EXECUTE FUNCTION "${schema}"."reject_terminal_proof"()`)
      try {
        await expect(reconcileTerminalSubmitJob(pool, submitQueue as unknown as SubmitOutboxQueue, terminalJob, "completed"))
          .rejects.toThrow("injected terminal proof write failure")
      } finally {
        await pool.query(`DROP TRIGGER "reject_terminal_proof" ON "${schema}"."application_task_events"`)
        await pool.query(`DROP FUNCTION "${schema}"."reject_terminal_proof"()`)
      }
      const retainedJob = await submitQueue!.getJob(identity.workerTaskId)
      expect(retainedJob?.id).toBe(identity.workerTaskId)
      expect(retainedJob?.data).toEqual(terminalJob?.data)
      expect(await retainedJob?.getState()).toBe("completed")
      expect(await (await submitQueue!.client).get(lockKey)).toBeNull()
      expect((await submitRecoverySnapshot(identity)).task).toMatchObject({ status: "filling", checkpoint: "browser_active" })
      expect((await submitRecoverySnapshot(identity)).events.filter(event => event.type === "submission_terminal_observed")).toHaveLength(0)

      const addSpy = vi.spyOn(submitQueue!, "add")
      try {
        await expect(drainApplicationSubmitOutbox(pool, submitQueue as unknown as SubmitOutboxQueue)).resolves.toBe(0)
        expect(addSpy).not.toHaveBeenCalled()
        const proof = await pool.query<{ data: Record<string, unknown> }>(
          `SELECT "data" FROM "${schema}"."application_task_events" WHERE "taskId" = $1 AND "type" = 'submission_terminal_observed'`,
          [identity.applicationTaskId],
        )
        expect(proof.rows).toHaveLength(1)
        expect(proof.rows[0]?.data).toMatchObject({ applicationTaskId: identity.applicationTaskId, userId: identity.userId,
          jobId: identity.jobId, sessionId: identity.sessionId, fillTurnId: identity.fillTurnId,
          workerTaskId: identity.workerTaskId, approvalId: identity.approvalId, receiptId: identity.approvalId,
          constraintHash: identity.constraintHash, terminalState: "completed" })
        expect(await submitQueue!.getJob(identity.workerTaskId)).toBeUndefined()
        const recoveredIntent: SubmitOutboxIntent = {
          applicationTaskId: identity.applicationTaskId, userId: identity.userId, jobId: identity.jobId,
          sessionId: identity.sessionId, fillTurnId: identity.fillTurnId, receiptId: identity.approvalId,
          constraintHash: identity.constraintHash, workerTaskId: identity.workerTaskId,
          submitPayload: terminalJob!.data,
        }
        await expect(reconcileClaimedTerminalSubmit(pool, submitQueue as unknown as SubmitOutboxQueue, recoveredIntent))
          .resolves.toBe("reconciled")
        expect((await submitRecoverySnapshot(identity)).events.filter(event => event.type === "submission_terminal_observed")).toHaveLength(1)
        await expect(drainApplicationSubmitOutbox(pool, submitQueue as unknown as SubmitOutboxQueue)).resolves.toBe(0)
        expect(addSpy).not.toHaveBeenCalled()
        await expect(drainApplicationSubmitOutbox(pool, submitQueue as unknown as SubmitOutboxQueue)).resolves.toBe(0)
        expect(addSpy).not.toHaveBeenCalled()
      } finally { addSpy.mockRestore() }

      const recovered = await submitRecoverySnapshot(identity)
      expect(recovered.task).toMatchObject({ status: "waiting_for_user", checkpoint: "submission_uncertain", workerTaskId: identity.workerTaskId })
      expect(recovered.job).toMatchObject({ status: "saved", workflowState: "submitting", appliedAt: null })
      expect(recovered.events.filter(event => event.type === "waiting_for_user")).toHaveLength(1)
      const outbox = await pool.query<{ publishedAt: Date | null; lastError: string | null }>(
        `SELECT "publishedAt", "lastError" FROM "${schema}"."agent_outbox" WHERE "id" = $1`, [outboxId],
      )
      expect(outbox.rows[0]?.lastError).toMatch(/^terminal:/)
      expect(outbox.rows[0]?.publishedAt).toBeInstanceOf(Date)
      addSpy.mockRestore()
    } finally {
      if (worker) await worker.close().catch(() => undefined)
      if (workerRedis && workerRedis.status !== "end") await workerRedis.quit().catch(() => workerRedis?.disconnect())
    }
  }, 20_000)

  it("surfaces a crashed pre-marker claim for review after terminal redelivery", async () => {
    const identity = await seedScenario("crashed-pre-marker-claim")
    await prepareSubmitClaim(identity)

    await expect(claimUnattendedSubmission(pool, identity, identity.workerTaskId)).resolves.toBe("claimed")
    const beforeRecovery = await pool.query<{ checkpoint: string; workflowState: string }>(
      `SELECT task."checkpoint", job."workflowState" FROM "${schema}"."application_tasks" task
       JOIN "${schema}"."Job" job ON job."id" = task."jobId" WHERE task."id" = $1`, [identity.applicationTaskId],
    )
    expect(beforeRecovery.rows[0]).toEqual({ checkpoint: "browser_active", workflowState: "submitting" })

    await expect(reconcileClaimedSubmissionUncertain(pool, identity, identity.workerTaskId, async () => true)).resolves.toBe(true)
    const recovered = await pool.query<{ status: string; checkpoint: string; workflowState: string }>(
      `SELECT task."status", task."checkpoint", job."workflowState" FROM "${schema}"."application_tasks" task
       JOIN "${schema}"."Job" job ON job."id" = task."jobId" WHERE task."id" = $1`, [identity.applicationTaskId],
    )
    expect(recovered.rows[0]).toEqual({ status: "waiting_for_user", checkpoint: "submission_uncertain", workflowState: "submitting" })
    await expect(claimUnattendedSubmission(pool, identity, identity.workerTaskId)).resolves.toBe("unavailable")
    expect(await pool.query(`SELECT 1 FROM "${schema}"."Job" WHERE "id" = $1 AND "workflowState" = 'ready_to_apply'`, [identity.jobId]))
      .toMatchObject({ rowCount: 0 })
  }, 15_000)

  it("surfaces a crashed post-marker claim for review without changing the Job", async () => {
    const identity = await seedScenario("crashed-post-marker-claim")
    await prepareSubmitClaim(identity)

    await expect(claimUnattendedSubmission(pool, identity, identity.workerTaskId)).resolves.toBe("claimed")
    const marker = await inTransaction(`${appPrefix}_request_started`, client => withExactAttemptFence(client, identity, () =>
      markSubmissionRequestStarted(client, {
        ...identity, turnId: identity.fillTurnId, workerTaskId: identity.workerTaskId, executionId: identity.executionId,
      })))
    expect(marker).toEqual({ kind: "current", value: "started" })

    const beforeRecovery = await pool.query<{ taskStatus: string; checkpoint: string; jobStatus: string; workflowState: string }>(
      `SELECT task."status" AS "taskStatus", task."checkpoint", job."status" AS "jobStatus", job."workflowState"
         FROM "${schema}"."application_tasks" task JOIN "${schema}"."Job" job ON job."id" = task."jobId"
        WHERE task."id" = $1`, [identity.applicationTaskId],
    )
    expect(beforeRecovery.rows[0]).toEqual({
      taskStatus: "filling", checkpoint: "submission_request_started", jobStatus: "saved", workflowState: "submitting",
    })

    await expect(reconcileClaimedSubmissionUncertain(pool, identity, identity.workerTaskId, async () => true)).resolves.toBe(true)
    const recovered = await pool.query<{ taskStatus: string; checkpoint: string; jobStatus: string; workflowState: string }>(
      `SELECT task."status" AS "taskStatus", task."checkpoint", job."status" AS "jobStatus", job."workflowState"
         FROM "${schema}"."application_tasks" task JOIN "${schema}"."Job" job ON job."id" = task."jobId"
        WHERE task."id" = $1`, [identity.applicationTaskId],
    )
    expect(recovered.rows[0]).toEqual({
      taskStatus: "waiting_for_user", checkpoint: "submission_uncertain", jobStatus: "saved", workflowState: "submitting",
    })
    await expect(claimUnattendedSubmission(pool, identity, identity.workerTaskId)).resolves.toBe("unavailable")
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
