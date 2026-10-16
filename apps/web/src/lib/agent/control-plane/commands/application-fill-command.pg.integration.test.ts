import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { acknowledgeApplicationFillCancellation, completeApplicationFillForReview, failApplicationFillBeforeBrowser, persistApplicationFillWait } from "../../../../../../worker/src/db/application-task-completion.js"
import { formAnswerKeyForSelector } from "../../../../../../worker/src/form-answer-key.js"
import { executeApplicationFillForReview } from "../../../../../../worker/src/runtime/subagents/application-fill-for-review.js"
import type { SubagentLease } from "../../../../../../worker/src/runtime/subagents/types.js"
import { insertApplyResultWithClient, persistLegacyApplicationTaskOutcome } from "../../../../../../worker/src/db/legacy-application-task-outcome.js"
import { AgentCommandService } from "./agent-command-service"
import { startApplicationFillForReview } from "./application-fill-command"

const browserContextSpy = vi.hoisted(() => vi.fn())
vi.mock("../../../../../../worker/src/cloak/pool.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../../../../worker/src/cloak/pool.js")>()
  return { ...original, withCloakContext: browserContextSpy }
})

const DATABASE_NAME = "applymate_agent_brain_ci"
const LOCK_SERIALIZATION_TEST_TIMEOUT_MS = 20_000
const LOCK_HANDSHAKE_TIMEOUT_MS = 5_000
const CLEANUP_WAIT_TIMEOUT_MS = 2_000
const BINDING_LOCK_TIMEOUT_MS = 3_000
const BINDING_TRANSACTION_TIMEOUT_MS = 4_000
const BINDING_ATTEMPT_WAIT_TIMEOUT_MS = 4_000

function disposableUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true"
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) {
    if (required) throw new Error("Application fill PostgreSQL tests need AGENT_RUNTIME_PG_TEST_URL and AGENT_RUNTIME_PG_TEST_DISPOSABLE=true")
    return null
  }
  if (process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") {
    throw new Error("Application fill PostgreSQL tests require AGENT_RUNTIME_PG_TEST_DISPOSABLE=true")
  }
  const url = new URL(value)
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5432"
    || url.username !== "postgres" || url.password !== "postgres" || url.pathname !== `/${DATABASE_NAME}`
    || url.search || url.hash) {
    throw new Error("Application fill PostgreSQL tests require the dedicated loopback disposable URL")
  }
  return value
}

const databaseUrl = disposableUrl()
const describePg = databaseUrl ? describe : describe.skip
const schema = `application_fill_${randomUUID().replaceAll("-", "")}`
const applicationName = `applymate-fill-${schema.slice(-12)}`
const ids = { user: `fill-user-${randomUUID()}`, session: `fill-session-${randomUUID()}`, task: `fill-task-${randomUUID()}`, job: `fill-job-${randomUUID()}`, resume: `fill-resume-${randomUUID()}` }
const fixture = readFileSync(fileURLToPath(new URL("./application-fill-command.pg.fixture.sql", import.meta.url)), "utf8")
type WorkerPgClient = { query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>; release(error?: Error | boolean): void }
type WorkerPgPool = { connect(): Promise<WorkerPgClient>; end(): Promise<void> }
const workerRequire = createRequire(new URL("../../../../../../worker/package.json", import.meta.url))
const WorkerPool = (workerRequire("pg") as { Pool: new (options: { connectionString: string; max: number }) => WorkerPgPool }).Pool
let admin: PrismaClient | undefined
let prisma: PrismaClient | undefined
let workerPool: WorkerPgPool | undefined
let workerSchemaPool: Parameters<typeof completeApplicationFillForReview>[0] | undefined
let schemaCreated = false

async function waitForSignal(signal: Promise<void>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      signal,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), LOCK_HANDSHAKE_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function waitUntilSettled(promise: Promise<unknown> | undefined, timeoutMs = CLEANUP_WAIT_TIMEOUT_MS): Promise<boolean> {
  if (!promise) return true
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function rollbackWithin(client: WorkerPgClient): Promise<boolean> {
  let rolledBack = false
  const rollback = client.query("ROLLBACK").then(() => { rolledBack = true }, () => undefined)
  return await waitUntilSettled(rollback) && rolledBack
}

async function disconnectPrismaWithin(client: PrismaClient): Promise<boolean> {
  let disconnected = false
  const disconnect = client.$disconnect().then(() => { disconnected = true }, () => undefined)
  return await waitUntilSettled(disconnect) && disconnected
}

function createLockBoundedPrisma(): PrismaClient {
  const url = new URL(databaseUrl!)
  url.searchParams.set("schema", schema)
  url.searchParams.set("options", `-c lock_timeout=${BINDING_LOCK_TIMEOUT_MS}ms`)
  url.searchParams.set("application_name", applicationName)
  return new PrismaClient({
    datasources: { db: { url: url.toString() } },
    transactionOptions: { maxWait: 1_000, timeout: BINDING_TRANSACTION_TIMEOUT_MS },
  })
}

type FillScenario = { userId: string; sessionId: string; taskId: string; jobId: string; resumeId: string }

async function seedFillScenario(): Promise<FillScenario> {
  const value = {
    userId: `recovery-user-${randomUUID()}`, sessionId: `recovery-session-${randomUUID()}`,
    taskId: `recovery-task-${randomUUID()}`, jobId: `recovery-job-${randomUUID()}`, resumeId: `recovery-resume-${randomUUID()}`,
  }
  await prisma!.$executeRaw`INSERT INTO "User" ("id", "email", "name", "accountStatus", "personaFields")
    VALUES (${value.userId}, ${`${value.userId}@example.test`}, 'Candidate', 'active', '[]'::jsonb)`
  await prisma!.$executeRaw`INSERT INTO "agent_sessions" ("id", "userId", "status") VALUES (${value.sessionId}, ${value.userId}, 'running')`
  await prisma!.$executeRaw`INSERT INTO "Job" ("id", "userId", "url", "role", "company", "keywords", "description")
    VALUES (${value.jobId}, ${value.userId}, 'https://boards.greenhouse.io/example/jobs/1', 'Engineer', 'Example', 'TypeScript', 'Engineer role')`
  await prisma!.$executeRaw`INSERT INTO "Resume" ("id", "userId", "targetJobId", "content")
    VALUES (${value.resumeId}, ${value.userId}, ${value.jobId}, '{"summary":"Candidate"}'::jsonb)`
  await prisma!.$executeRaw`INSERT INTO "application_tasks" ("id", "userId", "jobId", "sessionId", "resumeId", "status", "checkpoint")
    VALUES (${value.taskId}, ${value.userId}, ${value.jobId}, ${value.sessionId}, ${value.resumeId}, 'waiting_for_user', 'materials_ready')`
  return value
}

async function connectWorkerClient(): Promise<WorkerPgClient> {
  const client = await workerPool!.connect()
  try {
    await client.query(`SET search_path TO "${schema}"`)
    return client
  } catch (error) {
    client.release(true)
    throw error
  }
}

async function writeLegacyRaceOutcome(client: Parameters<typeof persistLegacyApplicationTaskOutcome>[0], value: FillScenario): Promise<void> {
  await insertApplyResultWithClient(client, {
    userId: value.userId, jobId: value.jobId, status: "failed", error: "legacy worker outcome", durationMs: 9,
  })
  await client.query('UPDATE "Job" SET status = $1, "workflowState" = $2 WHERE id = $3 AND "userId" = $4',
    ["saved", "ready_to_apply", value.jobId, value.userId])
  await client.query('UPDATE application_tasks SET status = $1, "checkpoint" = $2 WHERE id = $3 AND "userId" = $4 AND "jobId" = $5',
    ["failed", "worker_failed", value.taskId, value.userId, value.jobId])
}

async function startLeasedFill(
  value: FillScenario,
  turnId: string,
  checkpoint: "taskgraph_fill_queued" | "browser_active",
): Promise<SubagentLease> {
  const childId = `recovery-child-${randomUUID()}`
  const ownerId = `recovery-worker-${randomUUID()}`
  const leaseExpiresAt = new Date(Date.now() + 120_000)
  await prisma!.$executeRaw`UPDATE "agent_turns" SET "status" = 'in_progress' WHERE "id" = ${turnId}`
  await prisma!.$executeRaw`UPDATE "application_tasks" SET "status" = 'filling', "checkpoint" = ${checkpoint} WHERE "id" = ${value.taskId}`
  await prisma!.$executeRaw`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "role", "taskType", "status", "attemptCount", "leaseOwner", "leaseExpiresAt")
    VALUES (${childId}, ${value.sessionId}, ${turnId}, 'application_filler', 'application_fill_for_review', 'running', 1, ${ownerId}, ${leaseExpiresAt})`
  return {
    id: childId, userId: value.userId, sessionId: value.sessionId, turnId, rootTaskId: childId, parentTaskId: null,
    path: `/${childId}`, depth: 0, role: "application_filler", taskType: "application_fill_for_review", status: "running",
    goal: "Fill for review", constraints: [], successCriteria: [], allowedActions: [], context: {}, expectedOutputSchema: {},
    result: null, failureReason: null, attemptCount: 1, maxAttempts: 1, leaseOwner: ownerId, leaseExpiresAt,
    interruptRequestedAt: null, budgetSnapshot: {}, toolPolicySnapshot: {}, ownerId, signal: new AbortController().signal,
  }
}

describePg("application fill command PostgreSQL binding and idempotency", () => {
  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: databaseUrl! } } })
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    schemaCreated = true

    const scopedUrl = new URL(databaseUrl!)
    scopedUrl.searchParams.set("schema", schema)
    scopedUrl.searchParams.set("application_name", applicationName)
    prisma = new PrismaClient({ datasources: { db: { url: scopedUrl.toString() } } })
    const workerUrl = new URL(databaseUrl!)
    workerUrl.searchParams.set("application_name", applicationName)
    workerPool = new WorkerPool({ connectionString: workerUrl.toString(), max: 4 })
    workerSchemaPool = {
      connect: connectWorkerClient,
    } as unknown as Parameters<typeof completeApplicationFillForReview>[0]
    for (const statement of fixture.split(";").map((part) => part.trim()).filter(Boolean)) {
      await prisma.$executeRawUnsafe(statement)
    }
    await prisma.$executeRawUnsafe(`ALTER TABLE "Job"
      ADD COLUMN "status" TEXT, ADD COLUMN "workflowState" TEXT, ADD COLUMN "appliedAt" TIMESTAMP(3),
      ADD COLUMN "analysisNote" TEXT, ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`)
    await prisma.$executeRawUnsafe(`CREATE TABLE apply_results (
      id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, job_id TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'unattended',
      ats_type TEXT, flow_used TEXT, status TEXT NOT NULL, error TEXT, duration_ms INT, created_at TIMESTAMPTZ DEFAULT NOW())`)
    await prisma.$executeRaw`INSERT INTO "agent_sessions" ("id", "userId", "status") VALUES (${ids.session}, ${ids.user}, 'running')`
    await prisma.$executeRaw`INSERT INTO "Job" ("id", "userId") VALUES (${ids.job}, ${ids.user})`
    await prisma.$executeRaw`INSERT INTO "Resume" ("id", "userId", "targetJobId") VALUES (${ids.resume}, ${ids.user}, ${ids.job})`
    await prisma.$executeRaw`INSERT INTO "application_tasks" ("id", "userId", "jobId", "sessionId", "resumeId", "status", "checkpoint")
      VALUES (${ids.task}, ${ids.user}, ${ids.job}, ${ids.session}, ${ids.resume}, 'waiting_for_user', 'materials_ready')`
  })

  afterAll(async () => {
    await workerPool?.end()
    await prisma?.$disconnect()
    if (schemaCreated) await admin?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin?.$disconnect()
  })

  it("serializes duplicate and concurrent requests onto one bound Turn and dispatch", async () => {
    const launch = (clientMessageId: string) => startApplicationFillForReview(prisma!, {
      sessionId: ids.session, userId: ids.user, applicationTaskId: ids.task, clientMessageId,
    })
    const results = await Promise.all([launch("concurrent-fill-a"), launch("concurrent-fill-b"), launch("concurrent-fill-a")])

    expect(new Set(results.map((result) => result.turnId)).size).toBe(1)
    expect(results.filter((result) => result.disposition === "started")).toHaveLength(1)
    expect(results.filter((result) => result.disposition === "duplicate")).toHaveLength(2)
    await expect(prisma!.agentTurn.count({ where: { id: results[0]!.turnId } })).resolves.toBe(1)
    await expect(prisma!.agentInput.count({ where: { sessionId: ids.session } })).resolves.toBe(1)
    await expect(prisma!.agentEvent.count({ where: { sessionId: ids.session } })).resolves.toBe(2)
    await expect(prisma!.agentOutbox.count({ where: { aggregateId: ids.session } })).resolves.toBe(3)

    const bound = await prisma!.$queryRaw<Array<{ fillTurnId: string; fillTurnSessionId: string; fillTurnUserId: string }>>`
      SELECT "fillTurnId", "fillTurnSessionId", "fillTurnUserId" FROM "application_tasks" WHERE "id" = ${ids.task}
    `
    expect(bound[0]).toEqual({ fillTurnId: results[0]!.turnId, fillTurnSessionId: ids.session, fillTurnUserId: ids.user })
  })

  it("serializes legacy fill outcomes against TaskGraph binding in either commit order", async () => {
    const taskgraphFirst = await seedFillScenario()
    await prisma!.$executeRaw`UPDATE "Job" SET status = 'saved', "workflowState" = 'queued' WHERE id = ${taskgraphFirst.jobId}`
    const started = await startApplicationFillForReview(prisma!, {
      sessionId: taskgraphFirst.sessionId, userId: taskgraphFirst.userId, applicationTaskId: taskgraphFirst.taskId,
      clientMessageId: `race-taskgraph-first-${randomUUID()}`,
    })
    const boundClient = await connectWorkerClient()
    try {
      await boundClient.query("BEGIN")
      await boundClient.query("SELECT set_config($1, $2, true)", ["app.user_id", taskgraphFirst.userId])
      const result = await persistLegacyApplicationTaskOutcome(boundClient as unknown as Parameters<typeof persistLegacyApplicationTaskOutcome>[0], {
        applicationTaskId: taskgraphFirst.taskId, userId: taskgraphFirst.userId, jobId: taskgraphFirst.jobId,
      }, (client) => writeLegacyRaceOutcome(client, taskgraphFirst))
      await boundClient.query("COMMIT")
      expect(result).toEqual({ status: "taskgraph_bound" })
    } finally {
      boundClient.release()
    }
    await expect(prisma!.applicationTask.findUnique({ where: { id: taskgraphFirst.taskId }, select: { fillTurnId: true, status: true, checkpoint: true } }))
      .resolves.toEqual({ fillTurnId: started.turnId, status: "filling", checkpoint: "taskgraph_fill_queued" })
    await expect(prisma!.$queryRaw<Array<{ count: number }>>`SELECT COUNT(*)::int AS count FROM apply_results WHERE job_id = ${taskgraphFirst.jobId}`)
      .resolves.toEqual([{ count: 0 }])
    await expect(prisma!.$queryRaw<Array<{ status: string; workflowState: string }>>`SELECT status, "workflowState" FROM "Job" WHERE id = ${taskgraphFirst.jobId}`)
      .resolves.toEqual([{ status: "saved", workflowState: "queued" }])

    const workerFirst = await seedFillScenario()
    await prisma!.$executeRaw`UPDATE "Job" SET status = 'saved', "workflowState" = 'queued' WHERE id = ${workerFirst.jobId}`
    await prisma!.$executeRaw`UPDATE application_tasks SET status = 'filling', "checkpoint" = 'browser_active' WHERE id = ${workerFirst.taskId}`
    let workerClient: WorkerPgClient | undefined
    let observerClient: WorkerPgClient | undefined
    let bindingPrisma: PrismaClient | undefined
    let releaseWriter!: () => void
    let writerLocked!: () => void
    let outcomePromise: Promise<unknown> | undefined
    let bindingAttemptPromise: Promise<unknown> | undefined
    const writerGate = new Promise<void>((resolve) => { releaseWriter = resolve })
    const writerHasLock = new Promise<void>((resolve) => { writerLocked = resolve })
    try {
      workerClient = await connectWorkerClient()
      observerClient = await connectWorkerClient()
      const worker = workerClient
      const observer = observerClient
      await worker.query("BEGIN")
      await worker.query("SELECT set_config($1, $2, true)", ["app.user_id", workerFirst.userId])
      const outcome = (async () => {
        const result = await persistLegacyApplicationTaskOutcome(worker as unknown as Parameters<typeof persistLegacyApplicationTaskOutcome>[0], {
          applicationTaskId: workerFirst.taskId, userId: workerFirst.userId, jobId: workerFirst.jobId,
        }, async (client) => {
          writerLocked()
          await writerGate
          await writeLegacyRaceOutcome(client, workerFirst)
          return "legacy-committed"
        })
        await worker.query("COMMIT")
        return result
      })()
      outcomePromise = outcome
      await waitForSignal(writerHasLock, "legacy outcome writer lock")

      const bindingDb = createLockBoundedPrisma()
      bindingPrisma = bindingDb
      const bindingAttempt = startApplicationFillForReview(bindingDb, {
        sessionId: workerFirst.sessionId, userId: workerFirst.userId, applicationTaskId: workerFirst.taskId,
        clientMessageId: `race-worker-first-${randomUUID()}`,
      })
      bindingAttemptPromise = bindingAttempt
      let blocked = false
      for (let attempt = 0; attempt < 200; attempt++) {
        const state = await observer.query(`SELECT pid FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query ILIKE '%agent_sessions%' AND query ILIKE '%FOR UPDATE%'
            AND application_name = $1`, [applicationName])
        if (state.rows.length > 0) {
          blocked = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(blocked).toBe(true)
      releaseWriter()
      await expect(outcome).resolves.toEqual({ status: "persisted", value: "legacy-committed" })
      await expect(bindingAttempt).rejects.toMatchObject({ code: "retry_target_invalid", status: 409 })
    } finally {
      releaseWriter()
      const outcomeSettled = await waitUntilSettled(outcomePromise)
      let workerClientReleased = false
      if (workerClient) {
        if (!outcomeSettled) {
          workerClient.release(true)
          workerClientReleased = true
        } else if (!(await rollbackWithin(workerClient))) {
          workerClient.release(true)
          workerClientReleased = true
        }
      }
      const bindingSettled = await waitUntilSettled(bindingAttemptPromise, BINDING_ATTEMPT_WAIT_TIMEOUT_MS)
      let bindingCleanupFailure: string | undefined
      if (bindingPrisma) {
        if (!bindingSettled) {
          const disconnected = await disconnectPrismaWithin(bindingPrisma)
          const settledAfterDisconnect = await waitUntilSettled(bindingAttemptPromise)
          bindingCleanupFailure = !disconnected || !settledAfterDisconnect
            ? "Application-fill binding attempt exceeded its bounded wait and did not settle after dedicated client disconnect"
            : "Application-fill binding attempt exceeded its bounded wait; its dedicated Prisma client was disconnected during cleanup"
        } else if (!(await disconnectPrismaWithin(bindingPrisma))) {
          bindingCleanupFailure = "Application-fill binding Prisma client did not disconnect during cleanup"
        }
      }
      if (workerClient && !workerClientReleased) workerClient.release()
      observerClient?.release()
      if (bindingCleanupFailure) throw new Error(bindingCleanupFailure)
    }
    await expect(prisma!.$queryRaw<Array<{ count: number }>>`SELECT COUNT(*)::int AS count FROM apply_results WHERE job_id = ${workerFirst.jobId}`)
      .resolves.toEqual([{ count: 1 }])
    await expect(prisma!.applicationTask.findUnique({ where: { id: workerFirst.taskId }, select: { fillTurnId: true, status: true, checkpoint: true } }))
      .resolves.toEqual({ fillTurnId: null, status: "failed", checkpoint: "worker_failed" })
    await expect(prisma!.$queryRaw<Array<{ status: string; workflowState: string }>>`SELECT status, "workflowState" FROM "Job" WHERE id = ${workerFirst.jobId}`)
      .resolves.toEqual([{ status: "saved", workflowState: "ready_to_apply" }])
  }, LOCK_SERIALIZATION_TEST_TIMEOUT_MS)

  it("suppresses a legacy fill outcome after cancellation and serializes cancellation against an in-flight outcome", async () => {
    const cancelledFirst = await seedFillScenario()
    await prisma!.$executeRaw`UPDATE "Job" SET status = 'saved', "workflowState" = 'queued' WHERE id = ${cancelledFirst.jobId}`
    await prisma!.$executeRaw`UPDATE application_tasks SET status = 'filling', "checkpoint" = 'browser_active' WHERE id = ${cancelledFirst.taskId}`
    await prisma!.$executeRaw`UPDATE application_tasks SET status = 'cancelled', "checkpoint" = 'cancelled_by_user' WHERE id = ${cancelledFirst.taskId}`
    const staleWorker = await connectWorkerClient()
    try {
      await staleWorker.query("BEGIN")
      await staleWorker.query("SELECT set_config($1, $2, true)", ["app.user_id", cancelledFirst.userId])
      const outcome = await persistLegacyApplicationTaskOutcome(staleWorker as unknown as Parameters<typeof persistLegacyApplicationTaskOutcome>[0], {
        applicationTaskId: cancelledFirst.taskId, userId: cancelledFirst.userId, jobId: cancelledFirst.jobId,
      }, (client) => writeLegacyRaceOutcome(client, cancelledFirst))
      await staleWorker.query("COMMIT")
      expect(outcome).toEqual({ status: "task_inactive" })
    } finally {
      await staleWorker.query("ROLLBACK").catch(() => undefined)
      staleWorker.release()
    }
    await expect(prisma!.$queryRaw<Array<{ count: number }>>`SELECT COUNT(*)::int AS count FROM apply_results WHERE job_id = ${cancelledFirst.jobId}`)
      .resolves.toEqual([{ count: 0 }])
    await expect(prisma!.$queryRaw<Array<{ status: string; workflowState: string }>>`SELECT status, "workflowState" FROM "Job" WHERE id = ${cancelledFirst.jobId}`)
      .resolves.toEqual([{ status: "saved", workflowState: "queued" }])
    await expect(prisma!.applicationTask.findUnique({ where: { id: cancelledFirst.taskId }, select: { status: true, checkpoint: true } }))
      .resolves.toEqual({ status: "cancelled", checkpoint: "cancelled_by_user" })

    const outcomeFirst = await seedFillScenario()
    await prisma!.$executeRaw`UPDATE "Job" SET status = 'saved', "workflowState" = 'queued' WHERE id = ${outcomeFirst.jobId}`
    await prisma!.$executeRaw`UPDATE application_tasks SET status = 'filling', "checkpoint" = 'browser_active' WHERE id = ${outcomeFirst.taskId}`
    let workerClient: WorkerPgClient | undefined
    let cancellerClient: WorkerPgClient | undefined
    let cancellationObserverClient: WorkerPgClient | undefined
    let releaseWriter!: () => void
    let writerLocked!: () => void
    let outcomePromise: Promise<unknown> | undefined
    let cancellationPromise: Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> | undefined
    const writerGate = new Promise<void>((resolve) => { releaseWriter = resolve })
    const writerHasLock = new Promise<void>((resolve) => { writerLocked = resolve })
    try {
      workerClient = await connectWorkerClient()
      cancellerClient = await connectWorkerClient()
      cancellationObserverClient = await connectWorkerClient()
      const worker = workerClient
      const canceller = cancellerClient
      const cancellationObserver = cancellationObserverClient
      await worker.query("BEGIN")
      await worker.query("SELECT set_config($1, $2, true)", ["app.user_id", outcomeFirst.userId])
      const outcome = (async () => {
        const result = await persistLegacyApplicationTaskOutcome(worker as unknown as Parameters<typeof persistLegacyApplicationTaskOutcome>[0], {
          applicationTaskId: outcomeFirst.taskId, userId: outcomeFirst.userId, jobId: outcomeFirst.jobId,
        }, async (client) => {
          writerLocked()
          await writerGate
          await writeLegacyRaceOutcome(client, outcomeFirst)
          return "legacy-committed"
        })
        await worker.query("COMMIT")
        return result
      })()
      outcomePromise = outcome
      await waitForSignal(writerHasLock, "legacy outcome writer lock")

      cancellationPromise = canceller.query(`UPDATE application_tasks SET status = 'cancelled', "checkpoint" = 'cancelled_by_user', "completedAt" = NOW()
        WHERE id = $1 AND "userId" = $2 AND "sessionId" = $3 AND "fillTurnId" IS NULL
          AND "fillTurnSessionId" IS NULL AND "fillTurnUserId" IS NULL
          AND status NOT IN ('submitted', 'skipped', 'cancelled')
          AND ("checkpoint" IS NULL OR "checkpoint" NOT IN ('submission_request_started', 'submission_uncertain'))`,
      [outcomeFirst.taskId, outcomeFirst.userId, outcomeFirst.sessionId])
      let blocked = false
      for (let attempt = 0; attempt < 200; attempt++) {
        const state = await cancellationObserver.query(`SELECT pid FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query ILIKE '%UPDATE application_tasks%'
            AND application_name = $1`, [applicationName])
        if (state.rows.length > 0) { blocked = true; break }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(blocked).toBe(true)
      releaseWriter()
      await expect(outcome).resolves.toEqual({ status: "persisted", value: "legacy-committed" })
      await expect(cancellationPromise).resolves.toMatchObject({ rowCount: 1 })
    } finally {
      releaseWriter()
      const outcomeSettled = await waitUntilSettled(outcomePromise)
      let workerClientReleased = false
      if (workerClient) {
        if (!outcomeSettled) {
          workerClient.release(true)
          workerClientReleased = true
        } else if (!(await rollbackWithin(workerClient))) {
          workerClient.release(true)
          workerClientReleased = true
        }
      }
      const cancellationSettled = await waitUntilSettled(cancellationPromise)
      if (!cancellationSettled) cancellerClient?.release(true)
      if (workerClient && !workerClientReleased) workerClient.release()
      if (cancellationSettled) cancellerClient?.release()
      cancellationObserverClient?.release()
    }
    await expect(prisma!.$queryRaw<Array<{ count: number }>>`SELECT COUNT(*)::int AS count FROM apply_results WHERE job_id = ${outcomeFirst.jobId}`)
      .resolves.toEqual([{ count: 1 }])
    await expect(prisma!.applicationTask.findUnique({ where: { id: outcomeFirst.taskId }, select: { status: true, checkpoint: true } }))
      .resolves.toEqual({ status: "cancelled", checkpoint: "cancelled_by_user" })
  }, LOCK_SERIALIZATION_TEST_TIMEOUT_MS)

  it("rejects a Turn id whose stored session/user composite does not match the task", async () => {
    const original = await prisma!.$queryRaw<Array<{ fillTurnId: string; fillTurnSessionId: string; fillTurnUserId: string }>>`
      SELECT "fillTurnId", "fillTurnSessionId", "fillTurnUserId" FROM "application_tasks" WHERE "id" = ${ids.task}
    `
    const otherTurnId = `foreign-turn-${randomUUID()}`
    await prisma!.$executeRaw`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot")
      VALUES (${otherTurnId}, ${ids.session}, 'different-user', 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`

    await expect(prisma!.$executeRaw`UPDATE "application_tasks"
      SET "fillTurnId" = ${otherTurnId}, "fillTurnSessionId" = ${ids.session}, "fillTurnUserId" = ${ids.user}
      WHERE "id" = ${ids.task}`).rejects.toThrow()
    const rows = await prisma!.$queryRaw<Array<{ fillTurnId: string; fillTurnSessionId: string; fillTurnUserId: string }>>`
      SELECT "fillTurnId", "fillTurnSessionId", "fillTurnUserId" FROM "application_tasks" WHERE "id" = ${ids.task}
    `
    expect(rows[0]).toEqual(original[0])
  })

  it.each(["job ownership", "resume ownership/association", "cover-letter ownership/application association"])(
    "rejects invalid persisted %s before creating Turn or outbox work",
    async kind => {
      const userId = `material-user-${randomUUID()}`
      const sessionId = `material-session-${randomUUID()}`
      const taskId = `material-task-${randomUUID()}`
      const jobId = `material-job-${randomUUID()}`
      const resumeId = `material-resume-${randomUUID()}`
      const coverLetterId = `material-cover-${randomUUID()}`
      await prisma!.$executeRaw`INSERT INTO "agent_sessions" ("id", "userId", "status") VALUES (${sessionId}, ${userId}, 'running')`
      await prisma!.$executeRaw`INSERT INTO "Job" ("id", "userId") VALUES (${jobId}, ${kind === "job ownership" ? "other-user" : userId})`
      await prisma!.$executeRaw`INSERT INTO "Resume" ("id", "userId", "targetJobId") VALUES (${resumeId}, ${kind === "resume ownership/association" ? "other-user" : userId}, ${jobId})`
      if (kind === "cover-letter ownership/application association") {
        await prisma!.$executeRaw`INSERT INTO "CoverLetter" ("id", "userId", "jobId", "resumeId") VALUES (${coverLetterId}, 'other-user', ${jobId}, ${resumeId})`
      }
      await prisma!.$executeRaw`INSERT INTO "application_tasks" ("id", "userId", "jobId", "sessionId", "resumeId", "coverLetterId", "status", "checkpoint")
        VALUES (${taskId}, ${userId}, ${jobId}, ${sessionId}, ${resumeId}, ${kind === "cover-letter ownership/application association" ? coverLetterId : null}, 'waiting_for_user', 'materials_ready')`

      await expect(startApplicationFillForReview(prisma!, { sessionId, userId, applicationTaskId: taskId, clientMessageId: `invalid-${kind}` }))
        .rejects.toMatchObject({ code: "retry_target_invalid", status: 409 })
      await expect(prisma!.agentTurn.count({ where: { sessionId } })).resolves.toBe(0)
      await expect(prisma!.agentOutbox.count({ where: { aggregateId: sessionId } })).resolves.toBe(0)
    },
  )

  it("stops only the exact browser-active fill and fences late Worker completion and cancellation acknowledgement", async () => {
    const userId = `stop-fill-user-${randomUUID()}`
    const sessionId = `stop-fill-session-${randomUUID()}`
    const taskId = `stop-fill-task-${randomUUID()}`
    const jobId = `stop-fill-job-${randomUUID()}`
    const otherTaskId = `stop-fill-other-task-${randomUUID()}`
    const otherJobId = `stop-fill-other-job-${randomUUID()}`
    const resumeId = `stop-fill-resume-${randomUUID()}`
    const childId = `stop-fill-child-${randomUUID()}`
    const ownerId = `stop-fill-worker-${randomUUID()}`
    const leaseExpiresAt = new Date(Date.now() + 60_000)

    await prisma!.$executeRaw`INSERT INTO "agent_sessions" ("id", "userId", "status") VALUES (${sessionId}, ${userId}, 'running')`
    await prisma!.$executeRaw`INSERT INTO "Job" ("id", "userId") VALUES (${jobId}, ${userId}), (${otherJobId}, ${userId})`
    await prisma!.$executeRaw`INSERT INTO "Resume" ("id", "userId", "targetJobId") VALUES (${resumeId}, ${userId}, ${jobId})`
    await prisma!.$executeRaw`INSERT INTO "application_tasks" ("id", "userId", "jobId", "sessionId", "resumeId", "status", "checkpoint")
      VALUES (${taskId}, ${userId}, ${jobId}, ${sessionId}, ${resumeId}, 'waiting_for_user', 'materials_ready'),
        (${otherTaskId}, ${userId}, ${otherJobId}, ${sessionId}, NULL, 'filling', 'browser_active')`

    const started = await startApplicationFillForReview(prisma!, {
      sessionId, userId, applicationTaskId: taskId, clientMessageId: `stop-fill-launch-${randomUUID()}`,
    })
    await expect(prisma!.applicationTask.findUnique({ where: { id: taskId }, select: { fillTurnId: true, fillTurnSessionId: true, fillTurnUserId: true } }))
      .resolves.toEqual({ fillTurnId: started.turnId, fillTurnSessionId: sessionId, fillTurnUserId: userId })
    await prisma!.$executeRaw`UPDATE "agent_turns" SET "status" = 'in_progress' WHERE "id" = ${started.turnId}`
    await prisma!.$executeRaw`UPDATE "application_tasks" SET "status" = 'filling', "checkpoint" = 'browser_active' WHERE "id" = ${taskId}`
    await prisma!.$executeRaw`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "role", "taskType", "status", "attemptCount", "leaseOwner", "leaseExpiresAt")
      VALUES (${childId}, ${sessionId}, ${started.turnId}, 'application_filler', 'application_fill_for_review', 'running', 1, ${ownerId}, ${leaseExpiresAt})`

    const stopped = await new AgentCommandService(prisma!).interrupt({
      sessionId, userId, clientMessageId: `stop-fill-stop-${randomUUID()}`, source: "user",
      expectedTurnId: started.turnId, expectedRevision: 0,
    })
    expect(stopped).toMatchObject({ turnId: started.turnId, disposition: "interrupted" })
    await expect(prisma!.agentTurn.findUnique({ where: { id: started.turnId }, select: { status: true, revision: true } }))
      .resolves.toEqual({ status: "interrupted", revision: 1 })
    await expect(prisma!.applicationTask.findUnique({ where: { id: taskId }, select: { status: true, checkpoint: true } }))
      .resolves.toEqual({ status: "cancelled", checkpoint: "turn_stopped_before_submit" })
    await expect(prisma!.applicationTask.findUnique({ where: { id: otherTaskId }, select: { status: true, checkpoint: true } }))
      .resolves.toEqual({ status: "filling", checkpoint: "browser_active" })
    const interruptedChild = await prisma!.$queryRaw<Array<{ status: string; interruptRequestedAt: Date | null }>>`
      SELECT "status", "interruptRequestedAt" FROM "sub_agent_tasks" WHERE "id" = ${childId}
    `
    expect(interruptedChild[0]?.status).toBe("running")
    expect(interruptedChild[0]?.interruptRequestedAt).toBeInstanceOf(Date)

    const lease: SubagentLease = {
      id: childId, userId, sessionId, turnId: started.turnId, rootTaskId: childId, parentTaskId: null,
      path: `/${childId}`, depth: 0, role: "application_filler", taskType: "application_fill_for_review", status: "running",
      goal: "Fill for review", constraints: [], successCriteria: [], allowedActions: [], context: {}, expectedOutputSchema: {},
      result: null, failureReason: null, attemptCount: 1, maxAttempts: 1, leaseOwner: ownerId, leaseExpiresAt,
      interruptRequestedAt: null, budgetSnapshot: {}, toolPolicySnapshot: {}, ownerId, signal: new AbortController().signal,
    }
    await expect(completeApplicationFillForReview(workerSchemaPool!, { lease })).resolves.toEqual({ status: "stale" })
    const controller = new AbortController()
    controller.abort()
    lease.signal = controller.signal
    await prisma!.$executeRaw`UPDATE "sub_agent_tasks" SET "leaseOwner" = ${`${ownerId}-replacement`} WHERE "id" = ${childId}`
    await expect(acknowledgeApplicationFillCancellation(workerSchemaPool!, { lease })).resolves.toEqual({ status: "stale" })
    const staleAcknowledgementChild = await prisma!.$queryRaw<Array<{ status: string; leaseOwner: string | null; interruptRequestedAt: Date | null }>>`
      SELECT "status", "leaseOwner", "interruptRequestedAt" FROM "sub_agent_tasks" WHERE "id" = ${childId}
    `
    expect(staleAcknowledgementChild[0]).toMatchObject({ status: "running", leaseOwner: `${ownerId}-replacement` })
    expect(staleAcknowledgementChild[0]?.interruptRequestedAt).toBeInstanceOf(Date)
    await expect(prisma!.applicationTask.findUnique({ where: { id: taskId }, select: { status: true, checkpoint: true } }))
      .resolves.toEqual({ status: "cancelled", checkpoint: "turn_stopped_before_submit" })
    await expect(prisma!.applicationTaskEvent.count({ where: { taskId } })).resolves.toBe(0)

    await expect(startApplicationFillForReview(prisma!, {
      sessionId, userId, applicationTaskId: taskId, clientMessageId: `stop-retry-active-${randomUUID()}`, retry: true,
    })).rejects.toMatchObject({ code: "retry_target_invalid", status: 409 })
    await expect(prisma!.agentTurn.count({ where: { sessionId } })).resolves.toBe(1)
    await expect(prisma!.applicationTask.findUnique({ where: { id: taskId }, select: { status: true, checkpoint: true, fillTurnId: true } }))
      .resolves.toEqual({ status: "cancelled", checkpoint: "turn_stopped_before_submit", fillTurnId: started.turnId })

    await prisma!.$executeRaw`UPDATE "sub_agent_tasks" SET "status" = 'interrupted', "leaseOwner" = NULL,
      "leaseExpiresAt" = NULL, "completedAt" = CURRENT_TIMESTAMP WHERE "id" = ${childId}`
    const retried = await startApplicationFillForReview(prisma!, {
      sessionId, userId, applicationTaskId: taskId, clientMessageId: `stop-retry-fenced-${randomUUID()}`, retry: true,
    })

    expect(retried.disposition).toBe("started")
    expect(retried.turnId).not.toBe(started.turnId)
    await expect(prisma!.agentTurn.findUnique({ where: { id: started.turnId }, select: { status: true } }))
      .resolves.toEqual({ status: "interrupted" })
    await expect(prisma!.agentTurn.count({ where: { sessionId } })).resolves.toBe(2)
    await expect(prisma!.applicationTask.findUnique({ where: { id: taskId }, select: { fillTurnId: true, fillTurnSessionId: true, fillTurnUserId: true, status: true, checkpoint: true } }))
      .resolves.toEqual({ fillTurnId: retried.turnId, fillTurnSessionId: sessionId, fillTurnUserId: userId, status: "filling", checkpoint: "taskgraph_fill_queued" })
  })

  it("creates a retry Turn only after the previous failed fill Turn is terminal", async () => {
    const value = await seedFillScenario()
    const first = await startApplicationFillForReview(prisma!, {
      sessionId: value.sessionId, userId: value.userId, applicationTaskId: value.taskId, clientMessageId: `retry-first-${randomUUID()}`,
    })
    const lease = await startLeasedFill(value, first.turnId, "taskgraph_fill_queued")

    await expect(failApplicationFillBeforeBrowser(workerSchemaPool!, { lease })).resolves.toEqual({ status: "failed" })
    await expect(prisma!.applicationTask.findUnique({ where: { id: value.taskId }, select: { fillTurnId: true, status: true, checkpoint: true } }))
      .resolves.toEqual({ fillTurnId: first.turnId, status: "failed", checkpoint: "fill_prestart_failed" })
    await expect(startApplicationFillForReview(prisma!, {
      sessionId: value.sessionId, userId: value.userId, applicationTaskId: value.taskId, clientMessageId: `retry-too-early-${randomUUID()}`, retry: true,
    })).rejects.toMatchObject({ code: "retry_target_invalid", status: 409 })
    await expect(prisma!.agentTurn.count({ where: { sessionId: value.sessionId } })).resolves.toBe(1)
    await expect(prisma!.agentTurn.findUnique({ where: { id: first.turnId }, select: { status: true } })).resolves.toEqual({ status: "in_progress" })

    await prisma!.$executeRaw`UPDATE "agent_turns" SET "status" = 'failed' WHERE "id" = ${first.turnId}`
    await expect(startApplicationFillForReview(prisma!, {
      sessionId: value.sessionId, userId: value.userId, applicationTaskId: value.taskId, clientMessageId: `retry-filler-active-${randomUUID()}`, retry: true,
    })).rejects.toMatchObject({ code: "retry_target_invalid", status: 409 })
    await expect(prisma!.agentTurn.count({ where: { sessionId: value.sessionId } })).resolves.toBe(1)
    await expect(prisma!.$queryRaw<Array<{ status: string; leaseOwner: string | null }>>`
      SELECT "status", "leaseOwner" FROM "sub_agent_tasks" WHERE "id" = ${lease.id}
    `).resolves.toEqual([{ status: "running", leaseOwner: lease.leaseOwner }])

    await prisma!.$executeRaw`UPDATE "sub_agent_tasks" SET "status" = 'failed', "leaseOwner" = NULL,
      "leaseExpiresAt" = NULL, "completedAt" = CURRENT_TIMESTAMP WHERE "id" = ${lease.id}`
    const retried = await startApplicationFillForReview(prisma!, {
      sessionId: value.sessionId, userId: value.userId, applicationTaskId: value.taskId, clientMessageId: `retry-terminal-${randomUUID()}`, retry: true,
    })

    expect(retried.disposition).toBe("started")
    expect(retried.turnId).not.toBe(first.turnId)
    await expect(prisma!.agentTurn.count({ where: { sessionId: value.sessionId } })).resolves.toBe(2)
    await expect(prisma!.applicationTask.findUnique({ where: { id: value.taskId }, select: { fillTurnId: true, status: true, checkpoint: true } }))
      .resolves.toEqual({ fillTurnId: retried.turnId, status: "filling", checkpoint: "taskgraph_fill_queued" })
  })

  it("reuses the durable Turn after a command restart and does not reopen a browser-active fill", async () => {
    browserContextSpy.mockClear()
    const value = await seedFillScenario()
    const clientMessageId = `recovery-replay-${randomUUID()}`
    const first = await startApplicationFillForReview(prisma!, {
      sessionId: value.sessionId, userId: value.userId, applicationTaskId: value.taskId, clientMessageId,
    })
    const lease = await startLeasedFill(value, first.turnId, "browser_active")
    const scopedUrl = new URL(databaseUrl!)
    scopedUrl.searchParams.set("schema", schema)
    const restartedPrisma = new PrismaClient({ datasources: { db: { url: scopedUrl.toString() } } })
    let replay: Awaited<ReturnType<typeof startApplicationFillForReview>>
    try {
      replay = await startApplicationFillForReview(restartedPrisma, {
        sessionId: value.sessionId, userId: value.userId, applicationTaskId: value.taskId, clientMessageId,
      })
    } finally {
      await restartedPrisma.$disconnect()
    }

    expect(replay!).toMatchObject({ turnId: first.turnId, disposition: "duplicate" })
    await expect(executeApplicationFillForReview({ pool: workerSchemaPool!, lease }))
      .resolves.toMatchObject({ status: "waiting_for_user", failureReason: "fill_outcome_uncertain" })
    expect(browserContextSpy).not.toHaveBeenCalled()
    const waitEventCount = await prisma!.applicationTaskEvent.count({ where: { taskId: value.taskId, type: "fill_outcome_uncertain" } })
    await expect(executeApplicationFillForReview({ pool: workerSchemaPool!, lease }))
      .resolves.toMatchObject({ status: "waiting_for_user", failureReason: "fill_outcome_uncertain" })
    expect(browserContextSpy).not.toHaveBeenCalled()

    await expect(prisma!.agentTurn.count({ where: { sessionId: value.sessionId } })).resolves.toBe(1)
    await expect(prisma!.agentInput.count({ where: { sessionId: value.sessionId } })).resolves.toBe(1)
    await expect(prisma!.agentOutbox.count({ where: { aggregateId: value.sessionId, topic: "agent.turn.dispatch" } })).resolves.toBe(1)
    await expect(prisma!.applicationTask.findUnique({ where: { id: value.taskId }, select: { fillTurnId: true, status: true, checkpoint: true } }))
      .resolves.toEqual({ fillTurnId: first.turnId, status: "waiting_for_user", checkpoint: "fill_outcome_uncertain" })
    await expect(prisma!.applicationTaskEvent.count({ where: { taskId: value.taskId, type: "fill_outcome_uncertain" } }))
      .resolves.toBe(waitEventCount)
  })

  it("persists a form-answer wait and resumes safely with the confirmed answer on a successor Turn", async () => {
    const value = await seedFillScenario()
    const first = await startApplicationFillForReview(prisma!, {
      sessionId: value.sessionId, userId: value.userId, applicationTaskId: value.taskId, clientMessageId: `answer-wait-${randomUUID()}`,
    })
    const lease = await startLeasedFill(value, first.turnId, "browser_active")
    const answerKey = formAnswerKeyForSelector("work-authorization", "work_authorization")!

    await expect(persistApplicationFillWait(workerSchemaPool!, {
      lease, checkpoint: "form_answer_required", detail: "required_field", needs: {
        missing: [{ key: answerKey, label: "Work authorization" }, { key: null, label: "Work authorization" }], sensitive: [],
      },
    })).resolves.toEqual({ status: "waiting" })
    const waitQuestion = await prisma!.applicationTask.findUnique({ where: { id: value.taskId }, select: { question: true } })
    expect(waitQuestion?.question).toMatchObject({ missing: [{ key: answerKey, label: "Work authorization" }, { key: null, label: "Work authorization" }] })
    await prisma!.$executeRaw`UPDATE "sub_agent_tasks" SET "status" = 'waiting_for_user', "leaseOwner" = NULL, "leaseExpiresAt" = NULL
      WHERE "id" = ${lease.id}`
    const confirmedAnswers = JSON.stringify({ [answerKey]: "Ireland" })
    await prisma!.$executeRaw`UPDATE "application_tasks" SET "confirmedAnswers" = ${confirmedAnswers}::jsonb WHERE "id" = ${value.taskId}`
    const waitEvents = await prisma!.$queryRaw<Array<{ createdAt: Date }>>`SELECT "createdAt" FROM "application_task_events"
      WHERE "taskId" = ${value.taskId} AND "type" = 'form_answer_required' AND "actor" = 'worker'`
    expect(waitEvents).toHaveLength(1)
    const answeredAt = new Date(waitEvents[0]!.createdAt.getTime() + 10)
    await prisma!.$executeRaw`INSERT INTO "application_task_events" ("id", "taskId", "type", "actor", "body", "data", "createdAt")
      VALUES (${`answer-event-${randomUUID()}`}, ${value.taskId}, 'user_answers_confirmed', 'user', 'Candidate confirmed the required answer.', '{"answeredFieldCount":1}'::jsonb, ${answeredAt})`

    await expect(prisma!.applicationTask.findUnique({ where: { id: value.taskId }, select: { status: true, checkpoint: true, confirmedAnswers: true } }))
      .resolves.toEqual({ status: "waiting_for_user", checkpoint: "form_answer_required", confirmedAnswers: { [answerKey]: "Ireland" } })
    await expect(prisma!.agentTurn.findUnique({ where: { id: first.turnId }, select: { status: true } })).resolves.toEqual({ status: "waiting_for_user" })
    await expect(prisma!.agentSession.findUnique({ where: { id: value.sessionId }, select: { status: true } })).resolves.toEqual({ status: "waiting_for_user" })

    const resumeCommand = {
      sessionId: value.sessionId, userId: value.userId, applicationTaskId: value.taskId,
      clientMessageId: `resume-request-${randomUUID()}`, resumeAfterUserInput: true,
    }
    const resumed = await startApplicationFillForReview(prisma!, resumeCommand)
    const replay = await startApplicationFillForReview(prisma!, resumeCommand)

    expect(resumed.disposition).toBe("started")
    expect(resumed.turnId).not.toBe(first.turnId)
    expect(replay).toMatchObject({ turnId: resumed.turnId, disposition: "duplicate" })
    await expect(prisma!.agentTurn.count({ where: { sessionId: value.sessionId } })).resolves.toBe(2)
    await expect(prisma!.agentTurn.findUnique({ where: { id: first.turnId }, select: { status: true, revision: true } }))
      .resolves.toEqual({ status: "interrupted", revision: 2 })
    await expect(prisma!.agentSession.findUnique({ where: { id: value.sessionId }, select: { status: true } })).resolves.toEqual({ status: "running" })
    await expect(prisma!.applicationTask.findUnique({ where: { id: value.taskId }, select: { fillTurnId: true, status: true, checkpoint: true, confirmedAnswers: true } }))
      .resolves.toEqual({ fillTurnId: resumed.turnId, status: "filling", checkpoint: "taskgraph_fill_queued", confirmedAnswers: { [answerKey]: "Ireland" } })
    await expect(prisma!.$queryRaw<Array<{ status: string }>>`SELECT "status" FROM "sub_agent_tasks" WHERE "id" = ${lease.id}`)
      .resolves.toEqual([{ status: "interrupted" }])
    await expect(prisma!.agentOutbox.count({ where: { aggregateId: value.sessionId, topic: "agent.turn.dispatch" } })).resolves.toBe(2)
  })
})
