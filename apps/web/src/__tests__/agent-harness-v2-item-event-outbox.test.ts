import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { appendAgentEventWithOutbox, updateAgentItemRevision } from "../lib/agent/session/fact-store"

const migrationPath = fileURLToPath(new URL(
  "../../prisma/migrations/20260831040000_add_agent_item_event_outbox/migration.sql",
  import.meta.url,
))
const sourcePath = fileURLToPath(new URL("../lib/agent/session/fact-store.ts", import.meta.url))
const migrationSql = readFileSync(migrationPath, "utf8")
const factStoreSource = readFileSync(sourcePath, "utf8")

describe("Harness 2.0 Item/Event/Outbox migration contract", () => {
  it("adds additive durable tables and the session sequence counter", () => {
    expect(migrationSql).toContain('ADD COLUMN "eventSequence" BIGINT NOT NULL DEFAULT 0')
    expect(migrationSql).toContain('CREATE TABLE "agent_items"')
    expect(migrationSql).toContain('CREATE TABLE "agent_events"')
    expect(migrationSql).toContain('CREATE TABLE "agent_outbox"')
    expect(migrationSql).toContain('agent_events_sessionId_sequence_key')
    expect(migrationSql).toContain('agent_events_sessionId_idempotencyKey_key')
    expect(migrationSql).toContain('agent_outbox_idempotencyKey_key')
    expect(migrationSql).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i)
  })

  it("keeps the event, item, and outbox invariants in the database", () => {
    expect(migrationSql).toContain('"agent_events_sequence_check"')
    expect(migrationSql).toContain('"agent_events_actor_check"')
    expect(migrationSql).toContain('"agent_items_revision_check"')
    expect(migrationSql).toContain('"agent_items_sessionId_fkey"')
    expect(migrationSql).toContain('"agent_events_itemId_fkey"')
    expect(migrationSql).toContain('"agent_outbox_publishedAt_createdAt_idx"')
  })

  it("uses one UPDATE RETURNING statement for sequence allocation", () => {
    expect(factStoreSource).toContain('UPDATE "agent_sessions"')
    expect(factStoreSource).toContain('SET "eventSequence" = "eventSequence" + 1')
    expect(factStoreSource).toContain('RETURNING "eventSequence" AS "eventSequence"')
  })
})

const testDatabaseUrl = process.env.AGENT_HARNESS_TEST_DATABASE_URL
const integrationEnabled = process.env.AGENT_HARNESS_MIGRATION_INTEGRATION === "1" && Boolean(testDatabaseUrl)
const integrationDescribe = integrationEnabled ? describe : describe.skip

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  const code = error.code
  return typeof code === "string" ? code : undefined
}

integrationDescribe("Harness 2.0 PostgreSQL Item/Event/Outbox contract", () => {
  let prisma: PrismaClient
  let userId: string
  let sessionId: string
  let turnId: string
  let itemId: string

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } })
    const user = await prisma.user.create({
      data: { email: `ah2-006-${Date.now()}@example.invalid`, onboardingGoals: [] },
    })
    userId = user.id
    const session = await prisma.agentSession.create({
      data: { userId, goal: "AH2-006 migration fixture", status: "idle", source: "chat" },
    })
    sessionId = session.id
    const turn = await prisma.agentTurn.create({
      data: {
        sessionId,
        userId,
        status: "queued",
        source: "user",
        input: { content: [{ type: "text", text: "AH2-006 fixture" }] },
        modelProfileSnapshot: { provider: "test", model: "fixture" },
        toolPolicySnapshot: { allow: [] },
        budgetSnapshot: { maxCostUsd: 1 },
      },
    })
    turnId = turn.id
    const item = await prisma.agentItem.create({
      data: { id: `item-${Date.now()}`, sessionId, turnId, type: "agent_message", status: "started", content: {} },
    })
    itemId = item.id
  })

  afterAll(async () => {
    if (sessionId) await prisma.agentOutbox.deleteMany({ where: { aggregateId: sessionId } })
    if (sessionId) await prisma.agentSession.delete({ where: { id: sessionId } })
    if (userId) await prisma.user.delete({ where: { id: userId } })
    await prisma.$disconnect()
  })

  it("allocates 100 unique monotonic sequences under concurrent appends", async () => {
    const results = await Promise.all(Array.from({ length: 100 }, (_, index) => appendAgentEventWithOutbox(prisma, {
      sessionId,
      turnId,
      type: "fixture.concurrent_append",
      actor: "system",
      correlationId: `correlation-${index}`,
      idempotencyKey: `concurrent-${index}`,
      payload: { index },
      outboxTopic: "agent.events",
    })))

    expect(results.every((result) => !result.duplicate)).toBe(true)
    const events = await prisma.agentEvent.findMany({
      where: { sessionId, type: "fixture.concurrent_append" },
      orderBy: { sequence: "asc" },
    })
    expect(events).toHaveLength(100)
    expect(new Set(events.map((event) => event.sequence.toString())).size).toBe(100)
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 100 }, (_, index) => BigInt(index + 1)),
    )
  })

  it("returns the original event for a duplicate idempotency key", async () => {
    const first = await appendAgentEventWithOutbox(prisma, {
      sessionId,
      turnId,
      type: "fixture.duplicate",
      actor: "system",
      correlationId: "duplicate-correlation",
      idempotencyKey: "duplicate-key",
      payload: { value: 1 },
      outboxTopic: "agent.events",
    })
    const second = await appendAgentEventWithOutbox(prisma, {
      sessionId,
      turnId,
      type: "fixture.duplicate",
      actor: "system",
      correlationId: "duplicate-correlation",
      idempotencyKey: "duplicate-key",
      payload: { value: 2 },
      outboxTopic: "agent.events",
    })

    expect(first.event.id).toBe(second.event.id)
    expect(second.duplicate).toBe(true)
  })

  it("prevents a stale Item revision from overwriting the winner", async () => {
    const updates = await Promise.allSettled([
      updateAgentItemRevision(prisma, { itemId, expectedRevision: 0, content: { winner: 1 }, status: "streaming" }),
      updateAgentItemRevision(prisma, { itemId, expectedRevision: 0, content: { winner: 2 }, status: "streaming" }),
    ])

    expect(updates.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(updates.filter((result) => result.status === "rejected").map((result) => errorCode(result.reason))).toEqual([
      "agent_item_revision_conflict",
    ])
    await expect(prisma.agentItem.findUnique({ where: { id: itemId } })).resolves.toMatchObject({ revision: 1 })
  })

  it("rolls back an event and outbox written by the same transaction", async () => {
    const eventId = `rollback-event-${Date.now()}`
    const outboxId = `rollback-outbox-${Date.now()}`

    await expect(prisma.$transaction(async (tx) => {
      await tx.agentEvent.create({
        data: {
          id: eventId,
          sessionId,
          turnId,
          sequence: BigInt(10_000),
          type: "fixture.rollback",
          actor: "system",
          correlationId: "rollback-correlation",
          idempotencyKey: "rollback-key",
          payload: { failed: true },
        },
      })
      await tx.agentOutbox.create({
        data: {
          id: outboxId,
          topic: "agent.events",
          aggregateId: sessionId,
          idempotencyKey: "rollback-outbox-key",
          payload: { eventId },
        },
      })
      throw new Error("forced transaction failure")
    })).rejects.toThrow("forced transaction failure")

    await expect(prisma.agentEvent.findUnique({ where: { id: eventId } })).resolves.toBeNull()
    await expect(prisma.agentOutbox.findUnique({ where: { id: outboxId } })).resolves.toBeNull()
  })
})
