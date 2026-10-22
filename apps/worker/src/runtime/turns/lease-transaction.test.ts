import { describe, expect, it, vi } from "vitest"

import { hasPersistedNoProgressTerminalReceipt, transaction, withOpenLease } from "./lease-transaction.js"
import type { LeasePool, TurnLease } from "./lease.js"

type LeaseClient = Parameters<typeof hasPersistedNoProgressTerminalReceipt>[0]

function fixture(sessionRows: unknown[] = [{ id: "session-1" }]) {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values })
      if (sql.includes('SELECT session."id" FROM "agent_sessions"')) return { rows: sessionRows, rowCount: sessionRows.length }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn(async () => client) } as unknown as LeasePool, client, calls }
}

const lease: TurnLease = {
  turnId: "turn-1", sessionId: "session-1", ownerId: "worker-1", userId: "user-1", leaseVersion: 2,
  leaseStartedAt: new Date("2026-10-01T00:00:00.000Z"), leaseExpiresAt: new Date("2026-10-01T00:01:00.000Z"),
}

type NoProgressReceipt = {
  final: { schemaVersion: string; terminalReason: string; completed: boolean }
  stepStarted: { stepId: string; ordinal: number; taskId: string }
}

const exactNoProgressReceipt: NoProgressReceipt = {
  final: { schemaVersion: "agent-harness.v2.final", terminalReason: "no_progress", completed: false },
  stepStarted: { stepId: "step-1", ordinal: 2, taskId: "task-1" },
}

const requiredReceiptPredicates = [
  `step_start."payload" = jsonb_build_object('stepId', step."id", 'ordinal', step."ordinal", 'taskId', root."id")`,
  `turn_failed."payload"->'final'->>'schemaVersion' = 'agent-harness.v2.final'`,
  `turn_failed."payload"->'final'->>'terminalReason' = 'no_progress'`,
  `turn_failed."payload"->'final'->'completed' = 'false'::jsonb`,
]

function noProgressReceiptClient(receipt: NoProgressReceipt) {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const exactPayload = receipt.final.schemaVersion === exactNoProgressReceipt.final.schemaVersion
    && receipt.final.terminalReason === exactNoProgressReceipt.final.terminalReason
    && receipt.final.completed === exactNoProgressReceipt.final.completed
    && receipt.stepStarted.stepId === exactNoProgressReceipt.stepStarted.stepId
    && receipt.stepStarted.ordinal === exactNoProgressReceipt.stepStarted.ordinal
    && receipt.stepStarted.taskId === exactNoProgressReceipt.stepStarted.taskId
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values })
      const queryRequiresExactPayload = requiredReceiptPredicates.every(predicate => sql.includes(predicate))
      return queryRequiresExactPayload && exactPayload
        ? { rows: [{ id: lease.turnId }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    }),
  }
  return { client, calls }
}

describe("Turn lease transaction helpers", () => {
  it("sets the tenant scope and commits successful work", async () => {
    const fake = fixture()
    await expect(transaction(fake.pool, "user-1", async () => "saved")).resolves.toBe("saved")
    expect(fake.calls.map(call => call.sql)).toEqual(["BEGIN", "SELECT set_config('app.user_id', $1, true)", "COMMIT"])
    expect(fake.calls[1]?.values).toEqual(["user-1"])
    expect(fake.client.release).toHaveBeenCalledOnce()
  })

  it("rolls back failed work and releases the client", async () => {
    const fake = fixture()
    const failure = new Error("write failed")
    await expect(transaction(fake.pool, "user-1", async () => { throw failure })).rejects.toBe(failure)
    expect(fake.calls.map(call => call.sql)).toEqual(["BEGIN", "SELECT set_config('app.user_id', $1, true)", "ROLLBACK"])
    expect(fake.client.release).toHaveBeenCalledOnce()
  })

  it("runs open-lease work after locking the session and returns fallback when fenced", async () => {
    const fake = fixture()
    await expect(withOpenLease(fake.pool, lease, false, async () => true)).resolves.toBe(true)
    expect(fake.calls.find(call => call.sql.includes('SELECT session."id"'))?.sql).toContain("FOR UPDATE")
    expect(fake.calls.at(-1)?.sql).toBe("COMMIT")

    const closed = fixture([])
    await expect(withOpenLease(closed.pool, lease, false, async () => true)).resolves.toBe(false)
    expect(closed.calls.at(-1)?.sql).toBe("ROLLBACK")
    expect(closed.client.release).toHaveBeenCalledOnce()
  })

  it("accepts only exact no-progress final and step-start receipts", async () => {
    const fake = noProgressReceiptClient(exactNoProgressReceipt)

    await expect(hasPersistedNoProgressTerminalReceipt(fake.client as unknown as LeaseClient, lease)).resolves.toBe(true)

    const query = fake.calls[0]
    expect(query?.values).toEqual([lease.turnId, lease.sessionId, lease.userId, lease.leaseVersion])
    for (const predicate of requiredReceiptPredicates) expect(query?.sql).toContain(predicate)
  })

  it.each([
    ["final schema version", { final: { ...exactNoProgressReceipt.final, schemaVersion: "agent-harness.v1.final" } }],
    ["final terminal reason", { final: { ...exactNoProgressReceipt.final, terminalReason: "completed" } }],
    ["final completed flag", { final: { ...exactNoProgressReceipt.final, completed: true } }],
    ["step-start step id", { stepStarted: { ...exactNoProgressReceipt.stepStarted, stepId: "step-other" } }],
    ["step-start ordinal", { stepStarted: { ...exactNoProgressReceipt.stepStarted, ordinal: 3 } }],
    ["step-start task id", { stepStarted: { ...exactNoProgressReceipt.stepStarted, taskId: "task-other" } }],
  ] as const)("rejects a persisted receipt with a mismatched %s", async (_name, override) => {
    const fake = noProgressReceiptClient({ ...exactNoProgressReceipt, ...override })

    await expect(hasPersistedNoProgressTerminalReceipt(fake.client as unknown as LeaseClient, lease)).resolves.toBe(false)
    for (const predicate of requiredReceiptPredicates) expect(fake.calls[0]?.sql).toContain(predicate)
  })
})
