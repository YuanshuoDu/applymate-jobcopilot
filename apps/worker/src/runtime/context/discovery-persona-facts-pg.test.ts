import { createHash } from "node:crypto"
import type pg from "pg"
import { describe, expect, it, vi } from "vitest"
import { TurnEngineError } from "../turns/turn-engine-output.js"
import type { TurnLease } from "../turns/lease.js"
import { DISCOVERY_PERSONA_OVERFLOW_EVENT, DISCOVERY_PERSONA_SNAPSHOT_EVENT, loadOrCreateDiscoveryPersonaSnapshot,
  readDiscoveryPersonaSnapshotForCompaction } from "./discovery-persona-facts-pg.js"
import { projectDiscoveryPersonaFacts, type DiscoveryPersonaFactRow } from "./discovery-persona-facts.js"
import { estimateDiscoveryPersonaContextTokens } from "./discovery-persona-context-blocks.js"

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

type EventFixture = Record<string, unknown> & {
  id: string; sessionId: string; turnId: string; taskId: string; sequence: string; type: string; payload: unknown; idempotencyKey: string
}
const snapshotKey = `discovery-persona-snapshot:${lease.sessionId}:v1`
const overflowKey = `discovery-persona-overflow:${lease.sessionId}:${lease.turnId}:v1`
const readInput = { scope: { userId: lease.userId }, lease, rootTaskId: "root-a", rootAttemptCount: 1 }

function eventFixture(type: string, key: string, payload: unknown, overrides: Partial<EventFixture> = {}): EventFixture {
  const id = `agent-discovery-persona-${createHash("sha256").update(key).digest("hex")}`
  return { id, sessionId: lease.sessionId, turnId: lease.turnId, taskId: "root-a", sequence: "8", type,
    actor: "orchestrator", itemId: null, correlationId: "root-a", causationId: null, idempotencyKey: key, payload, ...overrides }
}

function outboxFixture(event: EventFixture): Record<string, unknown> {
  return { id: `agent-outbox-${event.id}`, topic: "agent.events", aggregateId: event.sessionId,
    idempotencyKey: `agent-event:${event.id}`, payload: { eventId: event.id, sessionId: event.sessionId,
      turnId: event.turnId, taskId: event.taskId, itemId: null, sequence: event.sequence, type: event.type,
      actor: "orchestrator", correlationId: event.taskId, causationId: null, idempotencyKey: event.idempotencyKey,
      payload: event.payload } }
}

function fakeReadPool(options: {
  readonly events?: Readonly<Record<string, EventFixture>>
  readonly outboxes?: Readonly<Record<string, Record<string, unknown>>>
  readonly missingSession?: boolean
  readonly missingTurn?: boolean
  readonly missingRoot?: boolean
  readonly missingRetainedTurn?: boolean
  readonly missingRetainedTask?: boolean
  readonly mismatchedRetainedRoot?: boolean
} = {}) {
  const queries: Array<{ sql: string; values: unknown[] }> = []
  const client = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values })
      if (sql.includes('FROM "agent_sessions"')) return { rows: options.missingSession ? [] : [{ id: lease.sessionId }], rowCount: options.missingSession ? 0 : 1 }
      if (sql.includes('FROM "agent_turns"')) {
        const currentOwner = sql.includes('"rootTaskId"=$4') && sql.includes("FOR UPDATE")
        const missing = currentOwner ? options.missingTurn : options.missingRetainedTurn
          || options.mismatchedRetainedRoot && sql.includes('"rootTaskId"=$4')
        return { rows: missing ? [] : [{ id: currentOwner ? lease.turnId : String(values[0]) }], rowCount: missing ? 0 : 1 }
      }
      if (sql.includes('FROM "sub_agent_tasks"')) {
        const currentOwner = sql.includes('task."status"=\'running\'')
        const missing = currentOwner ? options.missingRoot : options.missingRetainedTask
        return { rows: missing ? [] : [{ id: currentOwner ? "root-a" : String(values[0]) }], rowCount: missing ? 0 : 1 }
      }
      if (sql.includes('FROM "agent_events"')) {
        const rows = Object.values(options.events ?? {}).filter(event => event.idempotencyKey === values[0] || event.id === values[1])
        return { rows, rowCount: rows.length }
      }
      if (sql.includes('FROM "agent_outbox"')) {
        const row = options.outboxes?.[String(values[0])] ?? Object.values(options.outboxes ?? {}).find(candidate => candidate.id === values[1])
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
      }
      if (sql.includes('FROM "persona_facts"')) return { rows: [fact], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">
  return { pool, client, queries }
}

function retainedSnapshotEvent(): EventFixture {
  const result = projectDiscoveryPersonaFacts([fact])
  if (result.kind !== "accepted") throw new Error("Expected the fixture fact to fit the retained snapshot")
  return eventFixture(DISCOVERY_PERSONA_SNAPSHOT_EVENT, snapshotKey, result.payload)
}

function historicalSnapshotEvent(): EventFixture {
  return { ...retainedSnapshotEvent(), turnId: "turn-history", taskId: "root-history", correlationId: "root-history" }
}

function retainedOverflowEvent(): EventFixture {
  const rows = Array.from({ length: 33 }, (_, index): DiscoveryPersonaFactRow => ({ ...fact, id: `fact-${index}`,
    key: `preference-${index}`, value: `value-${index}`, normalizedValue: `value-${index}` }))
  const result = projectDiscoveryPersonaFacts(rows)
  if (result.kind !== "overflow") throw new Error("Expected the oversized fixture to produce an overflow receipt")
  return eventFixture(DISCOVERY_PERSONA_OVERFLOW_EVENT, overflowKey, result.payload)
}

function noWritesOrFactReads(queries: readonly { sql: string }[]): void {
  expect(queries.some(({ sql }) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false)
  expect(queries.some(({ sql }) => sql.includes('FROM "persona_facts"'))).toBe(false)
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

describe("read-only discovery persona snapshot for compaction", () => {
  it("estimates the verified retained projection under the advisory and current-owner locks", async () => {
    const event = retainedSnapshotEvent()
    const fake = fakeReadPool({ events: { [snapshotKey]: event }, outboxes: { [`agent-event:${event.id}`]: outboxFixture(event) } })

    const result = await readDiscoveryPersonaSnapshotForCompaction(fake.pool, readInput)
    const projection = projectDiscoveryPersonaFacts([fact])
    if (projection.kind !== "accepted") throw new Error("Expected accepted fact projection")
    expect(result).toEqual({ kind: "accepted", estimatedTokens: estimateDiscoveryPersonaContextTokens(projection.payload.projection) })
    const sql = fake.queries.map(query => query.sql)
    const advisoryIndex = sql.findIndex(query => query.includes("pg_advisory_xact_lock"))
    const sessionIndex = sql.findIndex(query => query.includes('FROM "agent_sessions"'))
    const turnIndex = sql.findIndex(query => query.includes('FROM "agent_turns"'))
    const rootIndex = sql.findIndex(query => query.includes('FROM "sub_agent_tasks"'))
    const eventIndex = sql.findIndex(query => query.includes('FROM "agent_events"'))
    expect(advisoryIndex).toBeGreaterThan(0)
    expect(sessionIndex).toBeGreaterThan(advisoryIndex)
    expect(turnIndex).toBeGreaterThan(sessionIndex)
    expect(rootIndex).toBeGreaterThan(turnIndex)
    expect(eventIndex).toBeGreaterThan(rootIndex)
    expect(fake.queries[advisoryIndex]?.values).toEqual([lease.userId])
    expect(fake.queries[sessionIndex]?.values).toEqual([lease.sessionId, lease.userId])
    expect(fake.queries[turnIndex]?.values).toEqual([lease.turnId, lease.sessionId, lease.userId, "root-a", lease.ownerId, lease.leaseVersion])
    expect(fake.queries[rootIndex]?.values).toEqual(["root-a", lease.sessionId, lease.turnId, lease.userId, lease.ownerId, 1])
    expect(sql.some(query => query.includes('FROM "agent_steps"'))).toBe(false)
    expect(sql.at(-1)).toBe("COMMIT")
    expect(fake.client.release).toHaveBeenCalledOnce()
    noWritesOrFactReads(fake.queries)
  })

  it("accepts a valid same-Session snapshot from an earlier Turn and Root", async () => {
    const event = historicalSnapshotEvent()
    const fake = fakeReadPool({ events: { [snapshotKey]: event }, outboxes: { [`agent-event:${event.id}`]: outboxFixture(event) } })
    const result = await readDiscoveryPersonaSnapshotForCompaction(fake.pool, readInput)
    const projection = projectDiscoveryPersonaFacts([fact])
    if (projection.kind !== "accepted") throw new Error("Expected accepted fact projection")
    expect(result).toEqual({ kind: "accepted", estimatedTokens: estimateDiscoveryPersonaContextTokens(projection.payload.projection) })
    expect(fake.queries.find(query => query.sql.includes('FROM "agent_turns"') && !query.sql.includes('"rootTaskId"=$4'))?.values)
      .toEqual(["turn-history", lease.sessionId, lease.userId])
    expect(fake.queries.find(query => query.sql.includes('FROM "sub_agent_tasks"') && !query.sql.includes('task."status"=\'running\''))?.values)
      .toEqual(["root-history", lease.sessionId, "turn-history", lease.userId])
    noWritesOrFactReads(fake.queries)
  })

  it("rejects a retained historical Turn when its canonical Root differs from the event Root", async () => {
    const event = historicalSnapshotEvent()
    const fake = fakeReadPool({ events: { [snapshotKey]: event }, outboxes: { [`agent-event:${event.id}`]: outboxFixture(event) },
      mismatchedRetainedRoot: true })

    await expect(readDiscoveryPersonaSnapshotForCompaction(fake.pool, readInput)).rejects.toMatchObject({ code: "persistence_conflict" })
    const historicalTurn = fake.queries.find(query => query.sql.includes('FROM "agent_turns"') && query.values[0] === "turn-history")
    expect(historicalTurn?.sql).toContain('AND "rootTaskId"=$4')
    expect(historicalTurn?.values).toEqual(["turn-history", lease.sessionId, lease.userId, "root-history"])
    expect(fake.queries.some(query => query.sql.includes('FROM "sub_agent_tasks"') && !query.sql.includes('task."status"=\'running\'')))
      .toBe(false)
    expect(fake.queries.at(-1)?.sql).toBe("ROLLBACK")
    noWritesOrFactReads(fake.queries)
  })

  it("rejects a deterministic retained event ID with a mismatched idempotency key", async () => {
    const event = { ...retainedSnapshotEvent(), idempotencyKey: "corrupted-idempotency-key" }
    const fake = fakeReadPool({ events: { orphanedEvent: event } })

    await expect(readDiscoveryPersonaSnapshotForCompaction(fake.pool, readInput)).rejects.toMatchObject({ code: "persistence_conflict" })
    const snapshotRead = fake.queries.find(query => query.sql.includes('FROM "agent_events"') && query.values[0] === snapshotKey)
    expect(snapshotRead?.sql).toContain('OR "id"=$2')
    expect(snapshotRead?.values).toEqual([snapshotKey, event.id])
    expect(fake.queries.at(-1)?.sql).toBe("ROLLBACK")
    noWritesOrFactReads(fake.queries)
  })

  it("returns absent only when both retained event keys are genuinely missing", async () => {
    const fake = fakeReadPool()
    await expect(readDiscoveryPersonaSnapshotForCompaction(fake.pool, readInput)).resolves.toEqual({ kind: "absent" })
    expect(fake.queries.filter(query => query.sql.includes('FROM "agent_events"'))).toHaveLength(2)
    expect(fake.queries.at(-1)?.sql).toBe("COMMIT")
    noWritesOrFactReads(fake.queries)
  })

  it.each([
    ["snapshot", retainedSnapshotEvent],
    ["overflow", retainedOverflowEvent],
  ] as const)("rejects an orphaned %s outbox instead of treating memory as absent", async (_label, makeEvent) => {
    const event = makeEvent()
    const fake = fakeReadPool({ outboxes: { [`agent-event:${event.id}`]: outboxFixture(event) } })
    await expect(readDiscoveryPersonaSnapshotForCompaction(fake.pool, readInput)).rejects.toMatchObject({ code: "persistence_conflict" })
    expect(fake.queries.some(query => query.sql.includes('FROM "agent_outbox"'))).toBe(true)
    expect(fake.queries.at(-1)?.sql).toBe("ROLLBACK")
    noWritesOrFactReads(fake.queries)
  })

  it.each([
    ["snapshot", retainedSnapshotEvent],
    ["overflow", retainedOverflowEvent],
  ] as const)("rejects an orphaned deterministic %s outbox ID with a mismatched key", async (_label, makeEvent) => {
    const event = makeEvent(), orphan = { ...outboxFixture(event), idempotencyKey: "agent-event:wrong-key" }
    const fake = fakeReadPool({ outboxes: { [orphan.idempotencyKey]: orphan } })
    await expect(readDiscoveryPersonaSnapshotForCompaction(fake.pool, readInput)).rejects.toMatchObject({ code: "persistence_conflict" })
    expect(fake.queries.some(query => query.sql.includes('FROM "agent_outbox"') && query.sql.includes('OR "id"=$2'))).toBe(true)
    expect(fake.queries.at(-1)?.sql).toBe("ROLLBACK")
    noWritesOrFactReads(fake.queries)
  })

  it("uses a verified overflow receipt instead of a snapshot or a fact-table fallback", async () => {
    const event = retainedOverflowEvent()
    const fake = fakeReadPool({ events: { [overflowKey]: event }, outboxes: { [`agent-event:${event.id}`]: outboxFixture(event) } })
    await expect(readDiscoveryPersonaSnapshotForCompaction(fake.pool, readInput)).resolves.toEqual({ kind: "overflow" })
    expect(fake.queries.filter(query => query.sql.includes('FROM "agent_events"'))).toHaveLength(1)
    expect(fake.queries.some(query => query.sql.includes('FROM "agent_outbox"'))).toBe(true)
    noWritesOrFactReads(fake.queries)
  })

  it.each([
    ["malformed payload", (event: EventFixture) => ({ ...event, payload: { status: "accepted" } }), true],
    ["foreign retained owner", (event: EventFixture) => ({ ...event, sessionId: "foreign-session" }), true],
  ])("fails closed for %s without reading PersonaFact", async (_label, mutate, includeOutbox) => {
    const event = mutate(retainedSnapshotEvent())
    const fake = fakeReadPool({ events: { [snapshotKey]: event },
      outboxes: includeOutbox ? { [`agent-event:${event.id}`]: outboxFixture(event) } : {} })
    await expect(readDiscoveryPersonaSnapshotForCompaction(fake.pool, readInput)).rejects.toMatchObject({ code: "persistence_conflict" })
    expect(fake.queries.at(-1)?.sql).toBe("ROLLBACK")
    expect(fake.client.release).toHaveBeenCalledOnce()
    noWritesOrFactReads(fake.queries)
  })

  it.each([
    ["orphan historical Turn", { missingRetainedTurn: true }],
    ["orphan historical Root", { missingRetainedTask: true }],
  ] as const)("rejects an extant snapshot with an %s owner instead of treating it as absent", async (_label, missing) => {
    const event = historicalSnapshotEvent()
    const fake = fakeReadPool({ events: { [snapshotKey]: event },
      outboxes: { [`agent-event:${event.id}`]: outboxFixture(event) }, ...missing })
    await expect(readDiscoveryPersonaSnapshotForCompaction(fake.pool, readInput)).rejects.toMatchObject({ code: "persistence_conflict" })
    expect(fake.queries.some(query => query.sql.includes('FROM "agent_events"'))).toBe(true)
    expect(fake.queries.at(-1)?.sql).toBe("ROLLBACK")
    noWritesOrFactReads(fake.queries)
  })

  it("rejects a mismatched private outbox receipt for an extant snapshot", async () => {
    const event = retainedSnapshotEvent()
    const mismatchedOutbox = { ...outboxFixture(event), topic: "foreign.topic" }
    const fake = fakeReadPool({ events: { [snapshotKey]: event }, outboxes: { [`agent-event:${event.id}`]: mismatchedOutbox } })
    await expect(readDiscoveryPersonaSnapshotForCompaction(fake.pool, readInput)).rejects.toMatchObject({ code: "persistence_conflict" })
    expect(fake.queries.some(query => query.sql.includes('FROM "agent_outbox"'))).toBe(true)
    expect(fake.queries.at(-1)?.sql).toBe("ROLLBACK")
    noWritesOrFactReads(fake.queries)
  })

  it("rejects an extant snapshot whose private outbox receipt is missing", async () => {
    const event = retainedSnapshotEvent()
    const fake = fakeReadPool({ events: { [snapshotKey]: event } })
    await expect(readDiscoveryPersonaSnapshotForCompaction(fake.pool, readInput)).rejects.toMatchObject({ code: "persistence_conflict" })
    expect(fake.queries.some(query => query.sql.includes('FROM "agent_outbox"'))).toBe(true)
    expect(fake.queries.at(-1)?.sql).toBe("ROLLBACK")
    noWritesOrFactReads(fake.queries)
  })

  it.each([
    ["Session", { missingSession: true }],
    ["Turn", { missingTurn: true }],
    ["Root", { missingRoot: true }],
  ] as const)("rejects a stale %s owner before retained-event reads", async (_label, missing) => {
    const fake = fakeReadPool(missing)
    await expect(readDiscoveryPersonaSnapshotForCompaction(fake.pool, readInput)).rejects.toMatchObject({ code: "lease_lost" })
    expect(fake.queries.some(query => query.sql.includes('FROM "agent_events"'))).toBe(false)
    expect(fake.queries.at(-1)?.sql).toBe("ROLLBACK")
    noWritesOrFactReads(fake.queries)
  })
})
