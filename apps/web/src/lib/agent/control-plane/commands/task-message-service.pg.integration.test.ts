import { randomUUID } from "node:crypto"

import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { TaskMessageError, TaskMessageService } from "./task-message-service"

const DATABASE_NAME = "applymate_agent_brain_ci"
function disposableUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true"
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) {
    if (required) throw new Error("Task message PostgreSQL tests need AGENT_RUNTIME_PG_TEST_URL and AGENT_RUNTIME_PG_TEST_DISPOSABLE=true")
    return null
  }
  if (process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") throw new Error("Task message PostgreSQL tests require AGENT_RUNTIME_PG_TEST_DISPOSABLE=true")
  const url = new URL(value)
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5432"
    || url.username !== "postgres" || url.password !== "postgres" || url.pathname !== `/${DATABASE_NAME}` || url.search || url.hash) {
    throw new Error("Task message PostgreSQL tests require the dedicated loopback disposable URL")
  }
  return value
}
const databaseUrl = disposableUrl()
const describePg = databaseUrl ? describe : describe.skip
const schema = `task_message_${randomUUID().replaceAll("-", "")}`
const ownerId = `message-owner-${randomUUID()}`
const now = new Date()
let admin: PrismaClient | undefined
let prisma: PrismaClient | undefined
let schemaCreated = false

async function createFixtureTables(client: PrismaClient): Promise<void> {
  const statements = [
    `CREATE TABLE "agent_sessions" ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "status" TEXT NOT NULL, "eventSequence" BIGINT NOT NULL DEFAULT 0)`,
    `CREATE TABLE "agent_turns" ("id" TEXT PRIMARY KEY, "sessionId" TEXT NOT NULL, "userId" TEXT NOT NULL, "status" TEXT NOT NULL, "rootTaskId" TEXT, UNIQUE ("id", "sessionId"))`,
    `CREATE TABLE "sub_agent_tasks" (
      "id" TEXT PRIMARY KEY, "sessionId" TEXT NOT NULL, "turnId" TEXT, "rootTaskId" TEXT, "parentTaskId" TEXT,
      "path" TEXT NOT NULL, "depth" INTEGER NOT NULL, "role" TEXT NOT NULL, "taskType" TEXT NOT NULL, "status" TEXT NOT NULL,
      "attemptCount" INTEGER NOT NULL DEFAULT 0, "leaseOwner" TEXT, "leaseExpiresAt" TIMESTAMP(3), "interruptRequestedAt" TIMESTAMP(3),
      UNIQUE ("id", "sessionId"))`,
    `CREATE TABLE "agent_mailbox_messages" (
      "id" TEXT PRIMARY KEY, "sessionId" TEXT NOT NULL, "turnId" TEXT NOT NULL, "fromTaskId" TEXT, "toTaskId" TEXT,
      "kind" TEXT NOT NULL, "targetAttemptCount" INTEGER, "payload" JSONB NOT NULL, "idempotencyKey" TEXT NOT NULL,
      "deliveredAt" TIMESTAMP(3), "consumedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE ("sessionId", "idempotencyKey"))`,
    `CREATE TABLE "agent_items" (
      "id" TEXT PRIMARY KEY, "sessionId" TEXT NOT NULL, "turnId" TEXT NOT NULL, "stepId" TEXT, "taskId" TEXT,
      "type" TEXT NOT NULL, "status" TEXT NOT NULL, "phase" TEXT, "revision" INTEGER NOT NULL DEFAULT 0, "content" JSONB NOT NULL,
      "startedAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE "agent_events" (
      "id" TEXT PRIMARY KEY, "sessionId" TEXT NOT NULL, "turnId" TEXT NOT NULL, "itemId" TEXT, "taskId" TEXT,
      "sequence" BIGINT NOT NULL, "type" TEXT NOT NULL, "actor" TEXT NOT NULL, "correlationId" TEXT NOT NULL,
      "causationId" TEXT, "idempotencyKey" TEXT, "payload" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE ("sessionId", "sequence"), UNIQUE ("sessionId", "idempotencyKey"))`,
    `CREATE TABLE "agent_outbox" (
      "id" TEXT PRIMARY KEY, "topic" TEXT NOT NULL, "aggregateId" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL UNIQUE,
      "payload" JSONB NOT NULL, "publishedAt" TIMESTAMP(3), "attemptCount" INTEGER NOT NULL DEFAULT 0,
      "lastError" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  ]
  for (const statement of statements) await client.$executeRawUnsafe(statement)
}

type Scenario = { userId: string; sessionId: string; turnId: string; rootTaskId: string; taskId: string }
async function seedScenario(options: { userId?: string; status?: string; turnStatus?: string; taskStatus?: string; leaseExpiresAt?: Date; attempt?: number } = {}): Promise<Scenario> {
  const id = randomUUID()
  const value = { userId: options.userId ?? ownerId, sessionId: `session-${id}`, turnId: `turn-${id}`, rootTaskId: `root-${id}`, taskId: `child-${id}` }
  const expires = options.leaseExpiresAt ?? new Date(Date.now() + 60_000)
  await prisma!.$executeRaw`INSERT INTO "agent_sessions" ("id", "userId", "status") VALUES (${value.sessionId}, ${value.userId}, ${options.status ?? "running"})`
  await prisma!.$executeRaw`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "rootTaskId")
    VALUES (${value.turnId}, ${value.sessionId}, ${value.userId}, ${options.turnStatus ?? "in_progress"}, ${value.rootTaskId})`
  await prisma!.$executeRaw`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status")
    VALUES (${value.rootTaskId}, ${value.sessionId}, ${value.turnId}, ${value.rootTaskId}, NULL, ${`/${value.rootTaskId}`}, 0, 'orchestrator', 'root', 'running')`
  await prisma!.$executeRaw`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "attemptCount", "leaseOwner", "leaseExpiresAt")
    VALUES (${value.taskId}, ${value.sessionId}, ${value.turnId}, ${value.rootTaskId}, ${value.rootTaskId}, ${`/${value.rootTaskId}/${value.taskId}`}, 1, 'researcher', 'research', ${options.taskStatus ?? "running"}, ${options.attempt ?? 2}, 'worker-1', ${expires})`
  return value
}

describePg("TaskMessageService PostgreSQL durability and rollback", () => {
  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: databaseUrl! } } })
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    schemaCreated = true
    const scoped = new URL(databaseUrl!)
    scoped.searchParams.set("schema", schema)
    prisma = new PrismaClient({ datasources: { db: { url: scoped.toString() } } })
    await createFixtureTables(prisma)
  })

  afterAll(async () => {
    await prisma?.$disconnect()
    if (schemaCreated) await admin?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin?.$disconnect()
  })

  it("persists the attempt-bound mailbox, item and event once; exact retries replay even after task completion", async () => {
    const value = await seedScenario()
    const service = new TaskMessageService(prisma!)
    const command = { ...value, userId: value.userId, clientMessageId: "client-once", text: "Check this result", expectedAttemptCount: 2 }
    const accepted = await service.send(command)
    expect(accepted).toMatchObject({ disposition: "accepted", turnId: value.turnId, taskId: value.taskId, targetAttemptCount: 2 })
    const message = await prisma!.agentMailboxMessage.findFirst({ where: { sessionId: value.sessionId }, select: { id: true, kind: true, targetAttemptCount: true, payload: true } })
    expect(message).toMatchObject({ id: accepted.messageId, kind: "human_follow_up", targetAttemptCount: 2, payload: { text: command.text } })
    const mailboxOutbox = await prisma!.agentOutbox.findUnique({ where: { idempotencyKey: `agent-subagent-mailbox:${value.sessionId}:client-once` }, select: { payload: true } })
    expect(mailboxOutbox?.payload).toEqual({ messageId: accepted.messageId, sessionId: value.sessionId, turnId: value.turnId,
      toTaskId: value.taskId, targetAttemptCount: 2 })
    const item = await prisma!.agentItem.findUnique({ where: { id: accepted.itemId }, select: { taskId: true, type: true, content: true } })
    expect(item).toMatchObject({ taskId: value.taskId, type: "user_message", content: { parts: [{ type: "text", text: command.text }] } })
    const event = await prisma!.agentEvent.findFirst({ where: { sessionId: value.sessionId, taskId: value.taskId }, select: { type: true, actor: true, itemId: true, payload: true } })
    expect(event).toMatchObject({ type: "input.accepted", actor: "user", itemId: accepted.itemId })
    expect(event?.payload).toMatchObject({ item: {
      id: accepted.itemId, taskId: value.taskId,
      content: "[REDACTED]",
    } })

    await prisma!.$executeRaw`UPDATE "sub_agent_tasks" SET "status" = 'completed', "attemptCount" = 3, "leaseOwner" = NULL, "leaseExpiresAt" = NULL WHERE "id" = ${value.taskId}`
    await prisma!.$executeRaw`UPDATE "sub_agent_tasks" SET "status" = 'completed' WHERE "id" = ${value.rootTaskId}`
    await prisma!.$executeRaw`UPDATE "agent_turns" SET "status" = 'completed' WHERE "id" = ${value.turnId}`
    await prisma!.$executeRaw`UPDATE "agent_sessions" SET "status" = 'completed' WHERE "id" = ${value.sessionId}`
    await expect(service.send(command)).resolves.toMatchObject({ ...accepted, disposition: "duplicate" })
    expect(await prisma!.agentMailboxMessage.count({ where: { sessionId: value.sessionId } })).toBe(1)
    expect(await prisma!.agentItem.count({ where: { sessionId: value.sessionId } })).toBe(1)
    expect(await prisma!.agentEvent.count({ where: { sessionId: value.sessionId } })).toBe(1)
  })

  it("rejects stale attempts, foreign ownership and expired leases without writes", async () => {
    const value = await seedScenario()
    const service = new TaskMessageService(prisma!)
    const base = { ...value, userId: value.userId, text: "Do not change the result" }
    await expect(service.send({ ...base, clientMessageId: "stale", expectedAttemptCount: 1 })).rejects.toMatchObject({ code: "task_follow_up_attempt_changed" })
    await expect(service.send({ ...base, userId: `foreign-${randomUUID()}`, clientMessageId: "foreign" })).rejects.toMatchObject({ status: 404 })
    const expired = await seedScenario({ leaseExpiresAt: new Date(Date.now() - 1) })
    await expect(service.send({ ...expired, userId: expired.userId, clientMessageId: "expired", text: "Too late" })).rejects.toBeInstanceOf(TaskMessageError)
    expect(await prisma!.agentMailboxMessage.count({ where: { sessionId: value.sessionId } })).toBe(0)
    expect(await prisma!.agentOutbox.count({ where: { aggregateId: value.sessionId } })).toBe(0)
    expect(await prisma!.agentItem.count({ where: { sessionId: value.sessionId } })).toBe(0)
    expect(await prisma!.agentEvent.count({ where: { sessionId: value.sessionId } })).toBe(0)
  })

  it("rolls back the mailbox and visible item when accepted-event outbox persistence fails", async () => {
    const value = await seedScenario()
    const clientMessageId = "rollback"
    const acceptedEventIdempotencyKey = `agent-task-follow-up-accepted:${value.sessionId}:${clientMessageId}`
    await prisma!.$executeRawUnsafe(`ALTER TABLE "agent_outbox" ADD CONSTRAINT "block_session_event" CHECK (
      "topic" <> 'agent.session.event' OR ("payload"->>'idempotencyKey') <> '${acceptedEventIdempotencyKey}')`)
    try {
      const service = new TaskMessageService(prisma!)
      await expect(service.send({ ...value, userId: value.userId, clientMessageId, text: "Rollback this" }))
        .rejects.toThrow()
      expect(await prisma!.agentMailboxMessage.count({ where: { sessionId: value.sessionId } })).toBe(0)
      expect(await prisma!.agentOutbox.count({ where: { aggregateId: value.sessionId } })).toBe(0)
      expect(await prisma!.agentItem.count({ where: { sessionId: value.sessionId } })).toBe(0)
      expect(await prisma!.agentEvent.count({ where: { sessionId: value.sessionId } })).toBe(0)
      const session = await prisma!.agentSession.findUnique({ where: { id: value.sessionId }, select: { eventSequence: true } })
      expect(session?.eventSequence).toBe(BigInt(0))
    } finally {
      await prisma!.$executeRawUnsafe(`ALTER TABLE "agent_outbox" DROP CONSTRAINT "block_session_event"`)
    }
  })
})
