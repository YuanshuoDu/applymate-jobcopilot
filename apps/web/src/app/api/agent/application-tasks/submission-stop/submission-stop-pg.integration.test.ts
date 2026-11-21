import { createHash, randomUUID } from "node:crypto"
import { createRequire } from "node:module"

import { PrismaClient } from "@prisma/client"
import { hashAgentReceiptValue } from "@jobcopilot/shared"
import { applicationSubmissionStopEventId } from "@jobcopilot/shared/application-submission-stop-protocol"
import { SignJWT } from "jose"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { EXTENSION_TOKEN_AUDIENCE, EXTENSION_TOKEN_ISSUER, getAuthJwtSecret } from "@/lib/auth-secret"
import { createApplicationSubmissionStopTarget } from "../submission-stop"
import { POST as postSubmissionStop } from "./route"
import { createApplicationSubmitRepository } from "../../../../../../../../apps/worker/src/db/application-submit-repo.js"
import type { ApplicationSubmissionStartScope } from "../../../../../../../../apps/worker/src/db/application-task-state.js"
import { createPgApprovalStore } from "../../../../../../../../apps/worker/src/runtime/approval/pg-store.js"
import { acquireApplicationSubmissionStartFenceWithStopProtocol } from "../../../../../../../../apps/worker/src/runtime/interrupt/application-submission-start-gate.js"

vi.mock("@/lib/safe-auth", () => ({ safeAuth: async () => null }))

const CI_DATABASE = "applymate_agent_brain_ci"
const LOCAL_DATABASE = "applymate_submission_evidence_1134_test"
const workerRequire = createRequire(new URL("../../../../../../../worker/package.json", import.meta.url))

type WorkerPool = Parameters<typeof createPgApprovalStore>[0]
type WorkerClient = Awaited<ReturnType<WorkerPool["connect"]>>
type PgModule = { Pool: new (options: Record<string, unknown>) => WorkerPool }
type Deferred = { promise: Promise<void>; resolve(): void }
type Attempt = {
  userId: string; foreignUserId: string; sessionId: string; fillTurnId: string; applicationTaskId: string; jobId: string
  approvalId: string; workerTaskId: string; executionId: string; constraintHash: string; target: string
}

function disposableDatabaseUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true"
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (process.env.CI === "true" && !required) return null
  if (!value || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") {
    if (required) throw new Error("Submission Stop PostgreSQL requires its explicitly disposable database URL")
    return null
  }
  const url = new URL(value)
  const expectedDatabase = process.env.CI === "true" ? CI_DATABASE : LOCAL_DATABASE
  const expectedPort = process.env.CI === "true" ? "5432" : "55434"
  if (value !== process.env.DATABASE_URL || url.protocol !== "postgresql:" || !["127.0.0.1", "localhost"].includes(url.hostname)
    || url.port !== expectedPort || url.username !== "postgres" || url.password !== "postgres"
    || decodeURIComponent(url.pathname.slice(1)) !== expectedDatabase || url.search || url.hash) {
    throw new Error("Submission Stop accepts only the matching named loopback disposable PostgreSQL database")
  }
  if (required && process.env.CI !== "true") throw new Error("Required Submission Stop PostgreSQL must run in CI")
  return value
}

const databaseUrl = disposableDatabaseUrl()
const describeWithPostgres = databaseUrl ? describe : describe.skip
const pg = workerRequire("pg") as unknown as PgModule
const testDb = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null
const workerPool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 2_000 }) : null
const observerPool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 2_000 }) : null
const userIds: string[] = []
const receiptIds: string[] = []
const runId = randomUUID().replaceAll("-", "")

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function waitForSignal(signal: Promise<void>, message: string, timeoutMs = 5_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([signal, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs) })])
  } finally { if (timer) clearTimeout(timer) }
}

function trackedWorkerPool(pool: WorkerPool, pids: number[], commitBarrier?: { reached: Deferred; release: Deferred }): WorkerPool {
  let paused = false
  const instrumented = {
    query: pool.query.bind(pool),
    end: pool.end.bind(pool),
    connect: async () => {
        const target = pool
        const client = await target.connect()
        const identity = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
        if (typeof identity.rows[0]?.pid === "number") pids.push(identity.rows[0].pid)
        await client.query("SELECT set_config('application_name', $1, false)", [`submission-stop-worker-${runId}`])
        const trackedClient = new Proxy(client, {
          get(connection, key) {
            if (key !== "query") return Reflect.get(connection, key, connection)
            return async <Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]) => {
              const result = await connection.query<Row>(sql, values as never)
              if (commitBarrier && !paused && sql.trim().toUpperCase() === "COMMIT") {
                paused = true
                commitBarrier.reached.resolve()
                await commitBarrier.release.promise
              }
              return result
            }
          },
        }) as unknown as WorkerClient
        return trackedClient
    },
  }
  return instrumented as unknown as WorkerPool
}

async function signedBearer(userId: string): Promise<string> {
  return new SignJWT({ authVersion: 1 }).setProtectedHeader({ alg: "HS256" })
    .setIssuer(EXTENSION_TOKEN_ISSUER).setAudience(EXTENSION_TOKEN_AUDIENCE)
    .setSubject(userId).setIssuedAt().setExpirationTime("5m").sign(getAuthJwtSecret())
}

async function requestStop(attempt: Attempt, userId: string): Promise<Response> {
  const token = await signedBearer(userId)
  return postSubmissionStop(new NextRequest("http://localhost/api/agent/application-tasks/submission-stop", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ applicationTaskId: attempt.applicationTaskId, expectedAttemptTarget: attempt.target, sessionId: attempt.sessionId }),
  }))
}

function eventIds(attempt: Attempt): string[] {
  const key = { sessionId: attempt.sessionId, fillTurnId: attempt.fillTurnId, applicationTaskId: attempt.applicationTaskId,
    userId: attempt.userId, jobId: attempt.jobId, approvalId: attempt.approvalId, receiptId: attempt.approvalId,
    constraintHash: attempt.constraintHash, workerTaskId: attempt.workerTaskId }
  return ["armed", "stop_requested", "dispatch_granted"].map(stage =>
    applicationSubmissionStopEventId(key, stage as "armed" | "stop_requested" | "dispatch_granted"))
}

async function protocolEvents(attempt: Attempt): Promise<Array<{ id: string; actor: string; data: unknown }>> {
  const result = await observerPool!.query<{ id: string; actor: string; data: unknown }>(
    `SELECT "id", "actor", "data" FROM "application_task_events" WHERE "taskId" = $1 AND "id" = ANY($2::text[]) ORDER BY "id"`,
    [attempt.applicationTaskId, eventIds(attempt)],
  )
  return result.rows
}

async function waitForStopBlockedBy(workerPid: number): Promise<number> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await observerPool!.query<{ pid: number; blocked: boolean }>(`
      SELECT pid, $1::integer = ANY(pg_blocking_pids(pid)) AS blocked
      FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock' AND query LIKE '%agent_sessions%'
    `, [workerPid])
    const blocked = result.rows.find(row => row.blocked && row.pid !== workerPid)
    if (blocked) return blocked.pid
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error("Authenticated Stop did not wait on the Worker-owned submission fence")
}

async function seedAttempt(label: string): Promise<Attempt> {
  const suffix = `${label}-${randomUUID()}`
  const userId = `stop-user-${suffix}`
  const foreignUserId = `stop-foreign-${suffix}`
  const sessionId = `stop-session-${suffix}`
  const fillTurnId = `stop-turn-${suffix}`
  const applicationTaskId = `stop-task-${suffix}`
  const jobId = `stop-job-${suffix}`
  const approvalId = `stop-approval-${suffix}`
  const workerTaskId = `stop-worker-task-${suffix}`
  const executionId = randomUUID()
  userIds.push(userId, foreignUserId)
  receiptIds.push(approvalId)

  await testDb!.user.createMany({ data: [
    { id: userId, email: `${suffix}@example.invalid`, onboardingGoals: [] },
    { id: foreignUserId, email: `foreign-${suffix}@example.invalid`, onboardingGoals: [] },
  ] })
  await testDb!.job.create({ data: { id: jobId, userId, company: "Synthetic Fixture", role: "Engineer", url: "https://jobs.example.invalid/apply" } })
  await testDb!.agentSession.create({ data: { id: sessionId, userId, goal: "Synthetic submission Stop fixture", source: "test", status: "running" } })
  await testDb!.agentTurn.create({ data: { id: fillTurnId, sessionId, userId, source: "user", status: "waiting_for_dependency",
    revision: 0, input: {}, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {},
    leaseOwnerId: null, leaseStartedAt: null, leaseExpiresAt: null, leaseVersion: 0 } })
  await testDb!.subAgentTask.create({ data: { id: `stop-filler-${suffix}`, sessionId, turnId: fillTurnId,
    role: "application_filler", taskType: "application_fill_for_review", status: "completed", goal: "Synthetic completed filler",
    constraints: [], successCriteria: [], allowedActions: [], context: {}, expectedOutputSchema: {},
    leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null } })
  await testDb!.applicationTask.create({ data: { id: applicationTaskId, userId, jobId, sessionId, fillTurnId,
    fillTurnSessionId: sessionId, fillTurnUserId: userId, status: "filling", checkpoint: "browser_active",
    workerTaskId, resumeId: null, coverLetterId: null } })

  const materialHash = await hashAgentReceiptValue("material", { applicationTaskId, jobId, resumeId: null, coverLetterId: null })
  const answersHash = await hashAgentReceiptValue("answers", null)
  const artifactHash = createHash("sha256").update(`synthetic-artifact:${applicationTaskId}`).digest("hex")
  const approvals = createPgApprovalStore(workerPool!, { userId })
  const issued = await approvals.issue({ approvalId, taskId: applicationTaskId,
    scope: { userId, sessionId, turnId: fillTurnId, jobId, toolCallId: `application-submit:${applicationTaskId}`,
      action: "submit_application", resourceHash: artifactHash, materialHash, answersHash, revision: 0,
      expiresAt: new Date(Date.now() + 60 * 60_000) },
    title: "Synthetic submission approval", body: "Disposable PostgreSQL Stop fixture.",
    payload: { applicationTaskId, jobId, resumeId: null, coverLetterId: null }, nonce: randomUUID(),
  })
  if (typeof issued.approval.scopeHash !== "string") throw new Error("Synthetic submit approval scope was not issued")
  await approvals.resolve({ id: approvalId, sessionId, decision: "approved" })
  const identity = { userId, sessionId, fillTurnId, applicationTaskId, jobId, approvalId, constraintHash: issued.approval.scopeHash }
  const repository = createApplicationSubmitRepository(workerPool!)
  const claim = await repository.reserveAndConsume(identity, async (client, mode) => {
    const approval = mode === "new"
      ? await approvals.consumeSubmissionInTransaction(client, approvalId, identity)
      : await approvals.inspectSubmissionInTransaction(client, approvalId, identity)
    return approval ? { kind: "authorized", artifactHash: approval.scope.resourceHash } : { kind: "fenced" }
  })
  if (claim.kind !== "reserved") throw new Error("Synthetic submit reservation did not succeed")
  const completedTurn = await testDb!.agentTurn.updateMany({
    where: { id: fillTurnId, sessionId, userId, status: "waiting_for_approval", revision: issued.approval.scope.revision + 1,
      leaseOwnerId: null, leaseStartedAt: null, leaseExpiresAt: null, leaseVersion: 0 },
    data: { status: "completed", revision: { increment: 1 }, completedAt: new Date() },
  })
  if (completedTurn.count !== 1) throw new Error("Synthetic approved Fill Turn did not complete at its exact wait revision")
  await testDb!.applicationTaskEvent.create({ data: { id: `queued-${suffix}`, taskId: applicationTaskId,
    type: "submission_queued", actor: "user", body: "Synthetic approved submit attempt queued.",
    data: { applicationTaskId, userId, jobId, sessionId, fillTurnId, approvalId, receiptId: approvalId,
      constraintHash: issued.approval.scopeHash, workerTaskId } } })
  const target = createApplicationSubmissionStopTarget({ ...identity, receiptId: approvalId, workerTaskId, executionId })
  return { ...identity, foreignUserId, workerTaskId, executionId, target }
}

function gateScope(attempt: Attempt): ApplicationSubmissionStartScope {
  return { sessionId: attempt.sessionId, fillTurnId: attempt.fillTurnId, turnId: attempt.fillTurnId,
    applicationTaskId: attempt.applicationTaskId, userId: attempt.userId, jobId: attempt.jobId,
    approvalId: attempt.approvalId, constraintHash: attempt.constraintHash,
    workerTaskId: attempt.workerTaskId, executionId: attempt.executionId }
}

describeWithPostgres("authenticated Submission Stop races the real Worker gate on disposable PostgreSQL", () => {
  beforeAll(async () => {
    if (!databaseUrl) return
    await Promise.all([testDb!.$connect(), observerPool!.query("SELECT 1")])
    const identity = await observerPool!.query<{ database: string; user: string }>("SELECT current_database() AS database, current_user AS user")
    const expected = process.env.CI === "true" ? CI_DATABASE : LOCAL_DATABASE
    if (identity.rows[0]?.database !== expected || identity.rows[0]?.user !== "postgres") {
      throw new Error("Submission Stop reached an unexpected disposable PostgreSQL identity")
    }
  })

  afterAll(async () => {
    if (!databaseUrl) return
    try {
      if (receiptIds.length) await workerPool!.query(`DELETE FROM "submission_attempt" WHERE "receiptId" = ANY($1::text[])`, [receiptIds])
      if (userIds.length) await testDb!.user.deleteMany({ where: { id: { in: userIds } } })
    } finally {
      await Promise.all([testDb!.$disconnect(), observerPool!.end(), workerPool!.end()])
    }
  })

  it("commits authenticated Stop after arm and before grant; the request is never acknowledged", async () => {
    const attempt = await seedAttempt("stop-first")
    const reached = deferred(), release = deferred()
    const pids: number[] = []
    const gatePool = trackedWorkerPool(workerPool!, pids, { reached, release })
    const gatePromise = acquireApplicationSubmissionStartFenceWithStopProtocol(gatePool, gateScope(attempt))
    try {
      await waitForSignal(reached.promise, "Worker did not commit the actual arm")
      const foreign = await requestStop(attempt, attempt.foreignUserId)
      expect(foreign.status).toBe(409)
      await expect(foreign.json()).resolves.toEqual({ outcome: "uncertain" })
      expect((await protocolEvents(attempt)).map(event => (event.data as { stage: string }).stage)).toEqual(["armed"])

      const stopped = await requestStop(attempt, attempt.userId)
      expect(stopped.status).toBe(200)
      await expect(stopped.json()).resolves.toEqual({ outcome: "stop_requested" })
      const repeated = await requestStop(attempt, attempt.userId)
      expect(repeated.status).toBe(200)
      await expect(repeated.json()).resolves.toEqual({ outcome: "stop_requested" })

      release.resolve()
      const gate = await gatePromise
      expect(gate.state).toBe("stopped")
      let syntheticAcknowledgements = 0
      if (gate.state === "ready") syntheticAcknowledgements += 1
      expect(syntheticAcknowledgements).toBe(0)
      expect((await protocolEvents(attempt)).map(event => (event.data as { stage: string }).stage).sort())
        .toEqual(["armed", "stop_requested"])
    } finally {
      release.resolve()
      const [settled] = await Promise.allSettled([gatePromise])
      if (settled.status === "fulfilled" && settled.value.state === "ready") {
        await settled.value.release(false).catch(() => undefined)
      }
    }
  }, 15_000)

  it("holds the final Worker fence until synthetic route acknowledgement; Stop then reports too late", async () => {
    const attempt = await seedAttempt("grant-first")
    const pids: number[] = []
    const gate = await acquireApplicationSubmissionStartFenceWithStopProtocol(trackedWorkerPool(workerPool!, pids), gateScope(attempt))
    if (gate.state !== "ready") throw new Error("Worker did not hold the exact final request fence")

    let stopSettled = false
    const stopPromise = requestStop(attempt, attempt.userId).then(response => { stopSettled = true; return response })
    let acknowledgementCount = 0
    const acknowledgement = deferred()
    const syntheticRouteCommand = acknowledgement.promise.then(() => { acknowledgementCount += 1 })
    let acknowledgementSent = false
    let gateCommitted = false
    try {
      const workerPid = pids[pids.length - 1]
      if (typeof workerPid !== "number") throw new Error("Worker final fence backend is unavailable")
      const webPid = await waitForStopBlockedBy(workerPid)
      expect(webPid).not.toBe(workerPid)
      expect(stopSettled).toBe(false)
      expect(acknowledgementCount).toBe(0)
      expect((await protocolEvents(attempt)).map(event => (event.data as { stage: string }).stage).sort())
        .toEqual(["armed", "dispatch_granted"])

      acknowledgement.resolve()
      acknowledgementSent = true
      await syntheticRouteCommand
      await gate.release(true)
      gateCommitted = true
      const tooLate = await stopPromise
      expect(tooLate.status).toBe(200)
      await expect(tooLate.json()).resolves.toEqual({ outcome: "too_late" })
      const repeated = await requestStop(attempt, attempt.userId)
      expect(repeated.status).toBe(200)
      await expect(repeated.json()).resolves.toEqual({ outcome: "too_late" })
      expect(acknowledgementCount).toBe(1)
      expect((await protocolEvents(attempt)).map(event => (event.data as { stage: string }).stage).sort())
        .toEqual(["armed", "dispatch_granted"])
    } finally {
      if (!gateCommitted) await gate.release(false).catch(() => undefined)
      if (acknowledgementSent) await syntheticRouteCommand.catch(() => undefined)
      await Promise.allSettled([stopPromise])
    }
  }, 15_000)
})
