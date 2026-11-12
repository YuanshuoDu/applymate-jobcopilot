import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createAgentSession } from "./repository"
import { AgentSessionIdempotencyConflictError } from "./agent-session-create-idempotency"

const expectedUrl = "postgresql://postgres:postgres@127.0.0.1:5432/applymate_custom_agent_role_ci"

function guardedDatabaseUrl(): string | null {
  const url = process.env.CUSTOM_AGENT_ROLE_PG_TEST_URL
  const requested = url !== undefined
    || process.env.CUSTOM_AGENT_ROLE_PG_TEST_DISPOSABLE !== undefined
    || process.env.CUSTOM_AGENT_ROLE_PG_TEST_REQUIRED !== undefined
  if (!requested) return null
  if (process.env.CI !== "true"
    || process.env.CUSTOM_AGENT_ROLE_PG_TEST_DISPOSABLE !== "true"
    || process.env.CUSTOM_AGENT_ROLE_PG_TEST_REQUIRED !== "true"
    || url !== expectedUrl
    || process.env.DATABASE_URL !== expectedUrl) {
    throw new Error("Session idempotency PostgreSQL tests require the fixed disposable CustomAgentRole CI database")
  }
  return url
}

const databaseUrl = guardedDatabaseUrl()
const describeWithDatabase = databaseUrl ? describe : describe.skip
let firstClient: PrismaClient
let secondClient: PrismaClient
const testUserIds = new Set<string>()

function sessionId(value: unknown): string {
  if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string") {
    throw new Error("Session repository returned no Session ID")
  }
  return value.id
}

async function createTestUser(): Promise<string> {
  const id = `session-idempotency-${randomUUID()}`
  testUserIds.add(id)
  await firstClient.user.create({ data: { id, email: `${id}@example.invalid` } })
  return id
}

function input(userId: string, goal: string, idempotencyKey?: string) {
  return { userId, goal, source: "chat" as const, ...(idempotencyKey ? { idempotencyKey } : {}) }
}

describeWithDatabase("agent session creation idempotency on disposable PostgreSQL", () => {
  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    url.searchParams.set("connection_limit", "1")
    firstClient = new PrismaClient({ datasources: { db: { url: url.toString() } } })
    secondClient = new PrismaClient({ datasources: { db: { url: url.toString() } } })
    await Promise.all([firstClient.$connect(), secondClient.$connect()])
  })

  afterAll(async () => {
    if (testUserIds.size > 0) {
      const ids = [...testUserIds]
      await firstClient.agentSession.deleteMany({ where: { userId: { in: ids } } })
      await firstClient.user.deleteMany({ where: { id: { in: ids } } })
    }
    await Promise.all([firstClient.$disconnect(), secondClient.$disconnect()])
  })

  it("returns the same Session for concurrent same-user, same-key, same-intent calls", async () => {
    const userId = await createTestUser()
    const request = input(userId, "Apply to Berlin SWE roles", "parallel-same")
    const [first, second] = await Promise.all([
      createAgentSession(firstClient, request),
      createAgentSession(secondClient, request),
    ])

    expect(sessionId(first)).toBe(sessionId(second))
    await expect(firstClient.agentSession.count({ where: { userId, creationIdempotencyKey: "parallel-same" } })).resolves.toBe(1)
  })

  it("allows only one concurrent intent per key and leaves the winning Session unchanged on replay", async () => {
    const userId = await createTestUser()
    const firstRequest = input(userId, "Apply to Berlin roles", "parallel-conflict")
    const secondRequest = input(userId, "Apply to Dublin roles", "parallel-conflict")
    const outcomes = await Promise.allSettled([
      createAgentSession(firstClient, firstRequest),
      createAgentSession(secondClient, secondRequest),
    ])
    const winner = outcomes.find((outcome) => outcome.status === "fulfilled")
    const conflict = outcomes.find((outcome) => outcome.status === "rejected")
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1)
    if (!winner || winner.status !== "fulfilled" || !conflict || conflict.status !== "rejected") {
      throw new Error("Concurrent different-intent requests did not produce one winner and one conflict")
    }
    expect(conflict.reason).toBeInstanceOf(AgentSessionIdempotencyConflictError)

    const winningRequest = winner === outcomes[0] ? firstRequest : secondRequest
    const selector = { userId_creationIdempotencyKey: { userId, creationIdempotencyKey: "parallel-conflict" } }
    const before = await firstClient.agentSession.findUnique({
      where: selector,
      select: { id: true, goal: true, updatedAt: true },
    })
    const replay = await createAgentSession(secondClient, winningRequest)
    const after = await firstClient.agentSession.findUnique({
      where: selector,
      select: { id: true, goal: true, updatedAt: true },
    })

    expect(sessionId(replay)).toBe(sessionId(winner.value))
    expect(after).toEqual(before)
    expect(after).toMatchObject({ goal: winningRequest.goal })
    await expect(firstClient.agentSession.count({ where: { userId, creationIdempotencyKey: "parallel-conflict" } })).resolves.toBe(1)
  })

  it("scopes identical keys to the authenticated user", async () => {
    const firstUserId = await createTestUser()
    const secondUserId = await createTestUser()
    const [first, second] = await Promise.all([
      createAgentSession(firstClient, input(firstUserId, "Same intent", "tenant-key")),
      createAgentSession(secondClient, input(secondUserId, "Same intent", "tenant-key")),
    ])

    expect(sessionId(first)).not.toBe(sessionId(second))
    await expect(firstClient.agentSession.count({ where: { userId: firstUserId, creationIdempotencyKey: "tenant-key" } })).resolves.toBe(1)
    await expect(firstClient.agentSession.count({ where: { userId: secondUserId, creationIdempotencyKey: "tenant-key" } })).resolves.toBe(1)
  })

  it("preserves ordinary keyless creation semantics", async () => {
    const userId = await createTestUser()
    const [first, second] = await Promise.all([
      createAgentSession(firstClient, input(userId, "Legacy session")),
      createAgentSession(secondClient, input(userId, "Legacy session")),
    ])

    expect(sessionId(first)).not.toBe(sessionId(second))
    await expect(firstClient.agentSession.count({ where: { userId, creationIdempotencyKey: null } })).resolves.toBe(2)
  })
})
