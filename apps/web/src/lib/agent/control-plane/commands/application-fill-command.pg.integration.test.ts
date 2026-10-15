import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { startApplicationFillForReview } from "./application-fill-command"

const DATABASE_NAME = "applymate_agent_brain_ci"

function disposableUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true"
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (process.env.CI !== "true" && !required) return null
  if (!value || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") {
    if (required) throw new Error("Application fill PostgreSQL tests need AGENT_RUNTIME_PG_TEST_URL and AGENT_RUNTIME_PG_TEST_DISPOSABLE=true")
    return null
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
let admin: PrismaClient | undefined
let prisma: PrismaClient | undefined
let schemaCreated = false

describePg("application fill command PostgreSQL binding and idempotency", () => {
  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: databaseUrl! } } })
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    schemaCreated = true

    const scopedUrl = new URL(databaseUrl!)
    scopedUrl.searchParams.set("schema", schema)
    prisma = new PrismaClient({ datasources: { db: { url: scopedUrl.toString() } } })
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
    const otherTurnId = `foreign-turn-${randomUUID()}`
    await prisma!.$executeRaw`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot")
      VALUES (${otherTurnId}, ${ids.session}, 'different-user', 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`

    await expect(prisma!.$executeRaw`UPDATE "application_tasks" SET "fillTurnId" = ${otherTurnId} WHERE "id" = ${ids.task}`).rejects.toThrow()
    const rows = await prisma!.$queryRaw<Array<{ fillTurnId: string; fillTurnSessionId: string; fillTurnUserId: string }>>`
      SELECT "fillTurnId", "fillTurnSessionId", "fillTurnUserId" FROM "application_tasks" WHERE "id" = ${ids.task}
    `
    expect(rows[0]).toMatchObject({ fillTurnSessionId: ids.session, fillTurnUserId: ids.user })
    expect(rows[0]?.fillTurnId).not.toBe(otherTurnId)
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
})
