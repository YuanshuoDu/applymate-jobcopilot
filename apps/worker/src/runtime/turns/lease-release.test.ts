import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { releaseTurnLease } from "./lease-release.js"
import type { LeasePool, TurnLease } from "./lease.js"

const now = new Date("2026-10-20T12:00:00Z")
const lease: TurnLease = { turnId: "turn-1", sessionId: "session-1", userId: "user-1", ownerId: "owner-1", leaseVersion: 4,
  leaseStartedAt: now, leaseExpiresAt: new Date("2026-10-20T12:01:00Z") }
const rootId = "root-1"
const terminal = { id: "terminal-event", sessionId: lease.sessionId, turnId: lease.turnId, taskId: rootId, itemId: "final-1",
  sequence: "12", type: "turn.failed", actor: "orchestrator", correlationId: lease.turnId, causationId: "final-completed",
  idempotencyKey: `turn:${lease.turnId}:event:turn-failed:provider_error`, payload: { turnId: lease.turnId, taskId: rootId,
    errorCode: "provider_error", finalItemId: "final-1", final: { schemaVersion: "agent-harness.v2.final" } } }
const terminalOutbox = { id: `agent-outbox-${terminal.id}`, topic: "agent.events", aggregateId: lease.sessionId,
  idempotencyKey: `agent-event:${terminal.id}`, payload: { eventId: terminal.id, sessionId: lease.sessionId, turnId: lease.turnId,
    taskId: rootId, itemId: terminal.itemId, sequence: terminal.sequence, type: terminal.type, actor: terminal.actor,
    correlationId: terminal.correlationId, causationId: terminal.causationId, idempotencyKey: terminal.idempotencyKey, payload: terminal.payload } }
const root = { id: rootId, rootTaskId: rootId, parentTaskId: null, role: "orchestrator", taskType: "root", status: "failed",
  leaseOwner: null, leaseExpiresAt: null, attemptCount: 1, completedAt: now, closedAt: null, nextAttemptAt: null, failureReason: "provider_error" }

function fixture(input: { rootRow?: Record<string, unknown>; parent?: Record<string, unknown> } = {}) {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const parentKey = input.parent?.idempotencyKey
  const events = new Map<string, Record<string, unknown>>([[typeof parentKey === "string" ? parentKey : terminal.idempotencyKey, input.parent ?? terminal]])
  const outboxes = new Map<string, Record<string, unknown>>([[terminalOutbox.idempotencyKey, terminalOutbox]])
  let turnRootId: string | null = rootId
  const client = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values })
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config") || sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 }
    if (sql.includes("pg_current_xact_id")) return { rows: [{ xid8: "55" }], rowCount: 1 }
    if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: lease.sessionId }], rowCount: 1 }
    if (sql.includes('UPDATE "agent_turns"')) return { rows: [{ rootTaskId: turnRootId }], rowCount: 1 }
    if (sql.includes('UPDATE "agent_inputs"')) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM "sub_agent_tasks"')) return input.rootRow === null ? { rows: [], rowCount: 0 } : { rows: [input.rootRow ?? root], rowCount: 1 }
    if (sql.includes('FROM "agent_events"')) {
      if (sql.includes('WHERE "id"=$1 AND "sessionId"=$2')) {
        const row = [...events.values()].find(event => event.id === values?.[0] && event.sessionId === values?.[1]
          && event.turnId === values?.[2] && event.taskId === values?.[3])
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
      }
      if (sql.includes('AND "type"=$4')) {
        const row = [...events.values()].find(event => event.sessionId === values?.[0] && event.turnId === values?.[1]
          && event.taskId === values?.[2] && event.type === values?.[3] && String(event.idempotencyKey).startsWith(String(values?.[4])))
        return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 }
      }
      const row = [...events.values()].find(event => event.idempotencyKey === values?.[0] || event.id === values?.[1]
        || event.idempotencyKey === values?.[2])
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }
    if (sql.includes('FROM "agent_outbox"')) {
      const row = [...outboxes.values()].find(entry => entry.idempotencyKey === values?.[0] || entry.id === values?.[1])
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }
    if (sql.includes('UPDATE "agent_sessions"')) return { rows: [{ eventSequence: "13" }], rowCount: 1 }
    if (sql.includes('INSERT INTO "agent_events"')) {
      const [id, sessionId, turnId, taskId, sequence, type, causationId, idempotencyKey, payload] = values ?? []
      const event = { id, sessionId, turnId, taskId, sequence, type, actor: "orchestrator", itemId: null,
        correlationId: taskId, causationId, idempotencyKey, payload: JSON.parse(String(payload)) }
      events.set(String(idempotencyKey), event)
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO "agent_outbox"')) {
      const [id, topic, aggregateId, idempotencyKey, payload] = values ?? []
      outboxes.set(String(idempotencyKey), { id, topic, aggregateId, idempotencyKey, payload: JSON.parse(String(payload)) })
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 1 }
  }), release: vi.fn() }
  return { client, calls, events, outboxes, pool: { connect: vi.fn(async () => client) } as unknown as LeasePool }
}

describe("terminal Turn lease chronology", () => {
  it("takes the chronology lock before Session and Turn writes, then records the verified root failure receipt", async () => {
    const fake = fixture()
    await expect(releaseTurnLease(fake.pool, lease, "failed", now)).resolves.toBe(true)
    const lock = fake.calls.findIndex(call => call.sql.includes("pg_advisory_xact_lock"))
    const xid = fake.calls.findIndex(call => call.sql.includes("pg_current_xact_id"))
    const session = fake.calls.findIndex(call => call.sql.includes('FROM "agent_sessions"') && call.sql.includes("FOR UPDATE"))
    const turn = fake.calls.findIndex(call => call.sql.includes('UPDATE "agent_turns"'))
    const marker = [...fake.events.values()].find(event => event.type === "agent.plan.root_task_history_chronology_witness")
    expect(lock).toBeLessThan(xid)
    expect(xid).toBeLessThan(session)
    expect(session).toBeLessThan(turn)
    expect(marker?.payload).toMatchObject({ boundary: "root_terminal", boundaryEventId: terminal.id, xid8: "55" })
    expect(fake.outboxes.size).toBe(2)
    expect(fake.calls.findIndex(call => call.sql.includes('INSERT INTO "agent_events"'))).toBeGreaterThan(turn)
    expect(fake.calls.at(-1)?.sql).toBe("COMMIT")
  })

  it("releases the Turn but omits chronology when the root receipt is not terminal", async () => {
    const fake = fixture({ rootRow: { ...root, status: "running", leaseOwner: lease.ownerId, leaseExpiresAt: lease.leaseExpiresAt, completedAt: null } })
    await expect(releaseTurnLease(fake.pool, lease, "failed", now)).resolves.toBe(true)
    expect([...fake.events.values()].some(event => event.type === "agent.plan.root_task_history_chronology_witness")).toBe(false)
    expect(fake.calls.at(-1)?.sql).toBe("COMMIT")
  })

  it("does not witness an interrupted release while the root receipt says failed", async () => {
    const interrupted = { ...terminal, id: "interrupted-event", type: "turn.interrupted",
      idempotencyKey: `turn:${lease.turnId}:event:turn-interrupted`,
      payload: { turnId: lease.turnId, taskId: rootId, errorCode: "provider_error" } }
    const fake = fixture({ parent: interrupted })
    await expect(releaseTurnLease(fake.pool, lease, "interrupted", now)).resolves.toBe(true)
    expect([...fake.events.values()].some(event => event.type === "agent.plan.root_task_history_chronology_witness")).toBe(false)
    expect(fake.calls.some(call => call.sql.includes('AND "type"=$4'))).toBe(false)
    expect(fake.calls.at(-1)?.sql).toBe("COMMIT")
  })

  it("does not witness a failed release while the root receipt says interrupted", async () => {
    const fake = fixture({ rootRow: { ...root, status: "interrupted" } })
    await expect(releaseTurnLease(fake.pool, lease, "failed", now)).resolves.toBe(true)
    expect([...fake.events.values()].some(event => event.type === "agent.plan.root_task_history_chronology_witness")).toBe(false)
    expect(fake.calls.some(call => call.sql.includes('AND "type"=$4'))).toBe(false)
    expect(fake.calls.at(-1)?.sql).toBe("COMMIT")
  })
})
