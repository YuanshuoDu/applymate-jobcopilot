import type pg from "pg"
import { describe, expect, it, vi } from "vitest"
import { TurnEngineError } from "../turns/turn-engine-output.js"
import type { TurnLease } from "../turns/lease.js"
import { DISCOVERY_PERSONA_OVERFLOW_EVENT, loadOrCreateDiscoveryPersonaSnapshot } from "./discovery-persona-facts-pg.js"
import type { DiscoveryPersonaFactRow } from "./discovery-persona-facts.js"

const lease: TurnLease = { userId: "user-a", sessionId: "session-a", turnId: "turn-a", ownerId: "worker-a", leaseVersion: 2,
  leaseStartedAt: new Date("2026-10-24T12:00:00.000Z"), leaseExpiresAt: new Date("2026-10-24T12:05:00.000Z") }
const input = { scope: { userId: lease.userId }, lease, rootTaskId: "root-a", rootAttemptCount: 1, stepId: "step-a" }
const fact: DiscoveryPersonaFactRow = { id: "fact-secret-id", key: "preferred_location", category: "preferences", value: "Dublin",
  normalizedValue: "dublin", source: "manual", evidence: { label: "Preferred location" }, updatedAt: new Date("2026-10-24T12:00:00.000Z") }

function fakePool(options: { failEventInsert?: boolean; retainedOverflow?: Record<string, unknown> } = {}) {
  const statements: string[] = []
  const eventKeys: unknown[] = []
  const client = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      statements.push(sql)
      if (sql.includes('FROM "agent_events"')) {
        eventKeys.push(values[0])
        if (options.retainedOverflow && String(values[0]).startsWith(`discovery-persona-overflow:${lease.sessionId}:${lease.turnId}:`)) {
          return { rows: [options.retainedOverflow], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: lease.sessionId }], rowCount: 1 }
      if (sql.includes('FROM "agent_turns"')) return { rows: [{ id: lease.turnId }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [{ id: "root-a" }], rowCount: 1 }
      if (sql.includes('FROM "agent_steps"')) return { rows: [{ id: "step-a" }], rowCount: 1 }
      if (sql.includes('FROM "persona_facts"')) return { rows: [fact], rowCount: 1 }
      if (sql.includes('UPDATE "agent_sessions"')) return { rows: [{ eventSequence: "1" }], rowCount: 1 }
      if (sql.includes('INSERT INTO "agent_events"') && options.failEventInsert) throw new Error("private database failure")
      if (sql.includes('INSERT INTO "agent_events"') || sql.includes('INSERT INTO "agent_outbox"')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">
  return { pool, client, statements, eventKeys }
}

describe("discovery persona snapshot transaction boundary", () => {
  it("rolls back a partially-written snapshot and returns only a safe persistence error", async () => {
    const fake = fakePool({ failEventInsert: true })
    await expect(loadOrCreateDiscoveryPersonaSnapshot(fake.pool, input)).rejects.toMatchObject({
      code: "persistence_conflict", message: "Discovery memory could not be verified; start a new Turn.",
    })
    expect(fake.statements.some(statement => statement === "ROLLBACK")).toBe(true)
    expect(fake.statements.some(statement => statement === "COMMIT")).toBe(false)
    expect(fake.statements.some(statement => statement.includes('INSERT INTO "agent_outbox"'))).toBe(false)
    expect(fake.client.release).toHaveBeenCalledOnce()
  })

  it("fails closed on a present misbound Turn overflow instead of falling through to a Session snapshot", async () => {
    const fake = fakePool({ retainedOverflow: { id: "malformed-event", sessionId: "foreign-session", turnId: lease.turnId,
      taskId: "foreign-root", sequence: "1", type: DISCOVERY_PERSONA_OVERFLOW_EVENT, actor: "orchestrator", itemId: null,
      correlationId: "foreign-root", causationId: null, idempotencyKey: "present-but-misbound", payload: {} } })
    const error = await loadOrCreateDiscoveryPersonaSnapshot(fake.pool, input).then(() => null, value => value)
    expect(error).toBeInstanceOf(TurnEngineError)
    expect(error).toMatchObject({ code: "persistence_conflict", message: "Discovery memory could not be verified; start a new Turn." })
    expect(fake.eventKeys).toHaveLength(1)
    expect(String(fake.eventKeys[0])).toContain(`discovery-persona-overflow:${lease.sessionId}:${lease.turnId}:v1`)
    expect(fake.statements.some(statement => statement.includes('FROM "persona_facts"'))).toBe(false)
    expect(fake.statements.some(statement => statement === "ROLLBACK")).toBe(true)
  })
})
