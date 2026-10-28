import { createHash } from "node:crypto"
import type pg from "pg"
import { describe, expect, it, vi } from "vitest"
import {
  ROOT_TASK_HISTORY_MEMORY_SNAPSHOT_EVENT_TYPE, ROOT_TASK_HISTORY_SESSION_AUTHORIZATION_EVENT_TYPE,
  withRootTaskHistorySessionAuthorization, type RootTaskHistorySessionAuthorizationInput,
} from "./root-task-history-session-memory.js"

const key = (sessionId: string) => `root-task-history-session-authorization:${sessionId}:v1`
const eventId = (value: string) => `agent-root-task-history-${createHash("sha256").update(value).digest("hex")}`
const input: RootTaskHistorySessionAuthorizationInput = {
  scope: { userId: "user-1" },
  lease: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", ownerId: "owner-1", leaseVersion: 2,
    leaseStartedAt: new Date("2026-10-28T10:00:00Z"), leaseExpiresAt: new Date("2026-10-28T10:05:00Z") },
  rootTaskId: "root-1", rootAttemptCount: 1, stepId: "step-1", environmentGateEnabled: true,
}

type Event = Record<string, unknown> & {
  id: string; sessionId: string; turnId: string; taskId: string; sequence: string; type: string
  actor: string; itemId: null; correlationId: string; causationId: null; idempotencyKey: string; payload: unknown
}
type Outbox = { id: string; topic: string; aggregateId: string; idempotencyKey: string; payload: unknown }
type FakeOptions = Readonly<{
  enabled?: boolean; version?: number; gate?: boolean; event?: Event | null; outbox?: Outbox | null
  orphanOutbox?: Outbox | null; failOwner?: boolean; failStep?: boolean
}>

function fakePool(options: FakeOptions = {}) {
  const calls: { sql: string; values: readonly unknown[] }[] = []
  let event = options.event ?? null, outbox = options.outbox ?? null, sequence = Number(event?.sequence ?? 0)
  const query = async (sql: string, values: readonly unknown[] = []) => {
    calls.push({ sql, values })
    const value = (index: number) => String(values[index])
    if (sql.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] }
    if (sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")) return { rows: [{ id: values[0] }] }
    if (sql.includes('FROM "agent_turns"')) return { rows: options.failOwner ? [] : [{ id: values[0] }] }
    if (sql.includes('FROM "sub_agent_tasks"')) return { rows: options.failOwner ? [] : [sql.includes("SELECT task.*")
      ? { id: values[0], rootTaskId: values[3], parentTaskId: null, role: "orchestrator", taskType: "root", status: "running",
        leaseOwner: values[5], attemptCount: values[6], interruptRequestedAt: null }
      : { id: values[0] }] }
    if (sql.includes('FROM "agent_steps"')) return { rows: options.failStep ? [] : [{ id: values[0] }] }
    if (sql.includes("WITH wall_clock")) return { rows: [{ turnLeaseValid: true, parentLeaseValid: true }] }
    if (sql.includes('FROM "agent_events"')) return { rows: event ? [event] : [] }
    if (sql.includes('FROM "User"')) return { rows: [{ id: input.lease.userId,
      agentTaskHistoryMemoryEnabled: options.enabled ?? true,
      agentTaskHistoryMemoryConsentVersion: options.version ?? 3 }] }
    if (sql.includes('FROM "agent_outbox"') && sql.includes('"topic"')) return { rows: outbox ? [outbox] : [] }
    if (sql.includes('FROM "agent_outbox"')) return { rows: options.orphanOutbox ? [options.orphanOutbox] : [] }
    if (sql.startsWith('UPDATE "agent_sessions"')) return { rows: [{ eventSequence: ++sequence }] }
    if (sql.startsWith('INSERT INTO "agent_events"')) {
      event = { id: value(0), sessionId: value(1), turnId: value(2), itemId: null, taskId: value(3), sequence: value(4),
        type: value(5), actor: "orchestrator", correlationId: value(3), causationId: null,
        idempotencyKey: value(6), payload: JSON.parse(value(7)) }
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('INSERT INTO "agent_outbox"')) {
      outbox = { id: value(0), topic: value(1), aggregateId: value(2), idempotencyKey: value(3), payload: JSON.parse(value(4)) }
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 1 }
  }
  const client = { query: vi.fn(query), release: vi.fn() } as unknown as pg.PoolClient
  return { pool: { connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">, client, calls,
    get event() { return event }, get outbox() { return outbox } }
}

function retainedEvent(payload: unknown = {
  schemaVersion: "agent-harness.v2.root-task-history-session-authorization.v1", sessionId: "session-1", userId: "user-1",
  consentVersion: 3, consentEnabled: true, gateEnabledAtCapture: true,
}): Event {
  const idempotencyKey = key(input.lease.sessionId)
  return { id: eventId(idempotencyKey), sessionId: input.lease.sessionId, turnId: "turn-1", taskId: "root-1", sequence: "1",
    type: ROOT_TASK_HISTORY_SESSION_AUTHORIZATION_EVENT_TYPE, actor: "orchestrator", itemId: null, correlationId: "root-1",
    causationId: null, idempotencyKey, payload }
}

function retainedOutbox(event: Event): Outbox {
  return { id: `agent-outbox-${event.id}`, topic: "agent.events", aggregateId: event.sessionId,
    idempotencyKey: `agent-event:${event.id}`, payload: {
      eventId: event.id, sessionId: event.sessionId, turnId: event.turnId, taskId: event.taskId, itemId: null,
      sequence: event.sequence, type: event.type, actor: "orchestrator", correlationId: event.taskId, causationId: null,
      idempotencyKey: event.idempotencyKey, payload: event.payload,
    } }
}

describe("root task history Session authorization", () => {
  it("pins consent under the shared advisory lock, current owner fence, and same transaction", async () => {
    const fake = fakePool(), work = vi.fn(async () => "history")
    const result = await withRootTaskHistorySessionAuthorization(fake.client, input, async (client, authorization, allowed) => {
      expect(client).toBe(fake.client); expect(authorization.consentEnabled).toBe(true); expect(allowed).toBe(true)
      return work()
    })
    const sql = fake.calls.map(call => call.sql)
    const lock = sql.findIndex(value => value.includes("pg_advisory_xact_lock"))
    const session = sql.findIndex(value => value.includes('FROM "agent_sessions"'))
    const turn = sql.findIndex(value => value.includes('FROM "agent_turns"'))
    const root = sql.findIndex(value => value.includes('FROM "sub_agent_tasks"'))
    const step = sql.findIndex(value => value.includes('FROM "agent_steps"') && value.includes('"taskId"=$4'))
    const consent = sql.findIndex(value => value.includes('FROM "User"'))
    const eventWrite = sql.findIndex(value => value.startsWith('INSERT INTO "agent_events"'))
    const outboxWrite = sql.findIndex(value => value.startsWith('INSERT INTO "agent_outbox"'))
    expect(lock).toBeGreaterThanOrEqual(0)
    expect(sql[lock]).toContain("applymate:agent-task-history-memory:")
    expect(fake.calls[lock]?.values).toEqual([input.lease.userId])
    expect(lock).toBeLessThan(session); expect(session).toBeLessThan(turn); expect(turn).toBeLessThan(root)
    expect(root).toBeLessThan(step); expect(step).toBeLessThan(consent); expect(consent).toBeLessThan(eventWrite)
    expect(eventWrite).toBeLessThan(outboxWrite)
    expect(result).toMatchObject({ historyReadAllowed: true, workResult: "history", authorization: {
      sessionId: input.lease.sessionId, userId: input.lease.userId, consentVersion: 3, consentEnabled: true, gateEnabledAtCapture: true,
    } })
    expect(fake.event).toMatchObject({ type: ROOT_TASK_HISTORY_SESSION_AUTHORIZATION_EVENT_TYPE, sequence: "1" })
    expect(fake.outbox).toMatchObject({ id: `agent-outbox-${fake.event?.id}`, idempotencyKey: `agent-event:${fake.event?.id}` })
    expect(work).toHaveBeenCalledOnce()
    expect(sql.some(value => ["BEGIN", "COMMIT", "ROLLBACK"].includes(value))).toBe(false)
  })

  it.each([
    ["the server gate is off", { enabled: true, gate: false }],
    ["pinned consent is off", { enabled: false, gate: true }],
  ] as const)("writes only the metadata marker when %s", async (_label, options) => {
    const fake = fakePool(options), work = vi.fn(async (_client: pg.PoolClient, _authorization: unknown, allowed: boolean) => {
      expect(allowed).toBe(false)
      return "ordinary context"
    })
    const result = await withRootTaskHistorySessionAuthorization(fake.client, { ...input, environmentGateEnabled: options.gate ?? true }, work)
    expect(result.historyReadAllowed).toBe(false)
    expect(result.workResult).toBe("ordinary context")
    expect(work).toHaveBeenCalledOnce()
    expect(fake.calls.some(call => call.sql.includes('FROM "User"'))).toBe(true)
    expect(fake.calls.some(call => /root.task.history|historical|prior.outcome/i.test(call.sql))).toBe(false)
    expect(fake.event?.type).toBe(ROOT_TASK_HISTORY_SESSION_AUTHORIZATION_EVENT_TYPE)
    expect(fake.calls.some(call => ["BEGIN", "COMMIT", "ROLLBACK"].includes(call.sql))).toBe(false)
  })

  it("replays the immutable enabled decision after user revocation without rereading User", async () => {
    const event = retainedEvent(), fake = fakePool({ enabled: false, version: 4, event, outbox: retainedOutbox(event) })
    const work = vi.fn(async () => "advisory projection")
    const result = await withRootTaskHistorySessionAuthorization(fake.client, input, async () => work())
    expect(result).toMatchObject({ historyReadAllowed: true, workResult: "advisory projection", authorization: {
      eventId: event.id, consentVersion: 3, consentEnabled: true,
    } })
    expect(fake.calls.some(call => call.sql.includes('FROM "User"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO'))).toBe(false)
    expect(work).toHaveBeenCalledOnce()
  })

  it("fails closed on corrupt authorization payload, mismatched outbox, or orphan outbox", async () => {
    const malformed = retainedEvent({ schemaVersion: "wrong" })
    const corrupt = fakePool({ event: malformed, outbox: retainedOutbox(malformed) })
    await expect(withRootTaskHistorySessionAuthorization(corrupt.client, input, async () => undefined))
      .rejects.toMatchObject({ code: "persistence_conflict" })

    const good = retainedEvent(), mismatched = retainedOutbox(good)
    const badOutbox = fakePool({ event: good, outbox: { ...mismatched, topic: "wrong" } })
    await expect(withRootTaskHistorySessionAuthorization(badOutbox.client, input, async () => undefined))
      .rejects.toMatchObject({ code: "persistence_conflict" })

    const orphan = fakePool({ orphanOutbox: { ...retainedOutbox(good), idempotencyKey: "agent-event:orphan" } })
    await expect(withRootTaskHistorySessionAuthorization(orphan.client, input, async () => undefined))
      .rejects.toMatchObject({ code: "persistence_conflict" })
    expect(orphan.calls.some(call => call.sql.includes('FROM "User"'))).toBe(false)
  })

  it("rolls back when the callback fails and rejects an owner-fence loss before consent reads", async () => {
    const failedWork = fakePool()
    await expect(withRootTaskHistorySessionAuthorization(failedWork.client, input, async () => { throw new Error("history failed") }))
      .rejects.toThrow("history failed")

    const lost = fakePool({ failOwner: true })
    await expect(withRootTaskHistorySessionAuthorization(lost.client, input, async () => undefined))
      .rejects.toMatchObject({ code: "lease_lost" })
    expect(lost.calls.some(call => call.sql.includes('FROM "User"'))).toBe(false)

    const lostStep = fakePool({ failStep: true })
    await expect(withRootTaskHistorySessionAuthorization(lostStep.client, input, async () => undefined))
      .rejects.toMatchObject({ code: "lease_lost" })
    expect(lostStep.calls.some(call => call.sql.includes('FROM "User"'))).toBe(false)
  })

  it("exports private event names without adding them to a public event contract", () => {
    expect(ROOT_TASK_HISTORY_SESSION_AUTHORIZATION_EVENT_TYPE).toBe("agent.plan.root_task_history_session_authorization")
    expect(ROOT_TASK_HISTORY_MEMORY_SNAPSHOT_EVENT_TYPE).toBe("agent.plan.root_task_history_memory_snapshot")
  })
})
