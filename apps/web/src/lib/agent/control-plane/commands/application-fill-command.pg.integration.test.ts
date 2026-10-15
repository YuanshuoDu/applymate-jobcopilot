import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { acknowledgeApplicationFillCancellation, completeApplicationFillForReview } from "../../../../../../worker/src/db/application-task-completion.js"
import type { SubagentLease } from "../../../../../../worker/src/runtime/subagents/types.js"
import { AgentCommandService } from "./agent-command-service"
import { startApplicationFillForReview } from "./application-fill-command"

const DATABASE_NAME = "applymate_agent_brain_ci"

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
const ids = { user: `fill-user-${randomUUID()}`, session: `fill-session-${randomUUID()}`, task: `fill-task-${randomUUID()}`, job: `fill-job-${randomUUID()}`, resume: `fill-resume-${randomUUID()}` }
const fixture = readFileSync(fileURLToPath(new URL("./application-fill-command.pg.fixture.sql", import.meta.url)), "utf8")
type WorkerPgClient = { query(sql: string, values?: unknown[]): Promise<unknown>; release(): void }
type WorkerPgPool = { connect(): Promise<WorkerPgClient>; end(): Promise<void> }
const workerRequire = createRequire(new URL("../../../../../../worker/package.json", import.meta.url))
const WorkerPool = (workerRequire("pg") as { Pool: new (options: { connectionString: string; max: number }) => WorkerPgPool }).Pool
let admin: PrismaClient | undefined
let prisma: PrismaClient | undefined
let workerPool: WorkerPgPool | undefined
let workerSchemaPool: Parameters<typeof completeApplicationFillForReview>[0] | undefined
let schemaCreated = false

describePg("application fill command PostgreSQL binding and idempotency", () => {
  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: databaseUrl! } } })
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    schemaCreated = true

    const scopedUrl = new URL(databaseUrl!)
    scopedUrl.searchParams.set("schema", schema)
    prisma = new PrismaClient({ datasources: { db: { url: scopedUrl.toString() } } })
    workerPool = new WorkerPool({ connectionString: databaseUrl!, max: 2 })
    workerSchemaPool = {
      connect: async () => {
        const client = await workerPool!.connect()
        await client.query(`SET search_path TO "${schema}"`)
        return client
      },
    } as unknown as Parameters<typeof completeApplicationFillForReview>[0]
    for (const statement of fixture.split(";").map((part) => part.trim()).filter(Boolean)) {
      await prisma.$executeRawUnsafe(statement)
    }
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

  it("rejects a Turn id whose stored session/user composite does not match the task", async () => {
    const original = await prisma!.$queryRaw<Array<{ fillTurnId: string; fillTurnSessionId: string; fillTurnUserId: string }>>`
      SELECT "fillTurnId", "fillTurnSessionId", "fillTurnUserId" FROM "application_tasks" WHERE "id" = ${ids.task}
    `
    expect(original[0]).toMatchObject({ fillTurnId: expect.any(String), fillTurnSessionId: ids.session, fillTurnUserId: ids.user })
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
  })
})
