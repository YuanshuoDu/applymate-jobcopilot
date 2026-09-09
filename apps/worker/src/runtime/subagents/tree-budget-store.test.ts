import { describe, expect, it, vi } from "vitest"

import { createPgTreeBudgetReservationStore, TreeBudgetStoreError } from "./tree-budget-store.js"
import type { TreeBudgetReservation } from "./tree-budget-types.js"

const input = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", taskId: "task-1", stepId: "step-1", attempt: 1, idempotencyKey: "step:step-1:1",
}

function reservation(overrides: Partial<TreeBudgetReservation> = {}): TreeBudgetReservation {
  const now = new Date("2026-09-09T09:00:00.000Z")
  return { ...input, id: "tree-step-1", units: 1, status: "reserved", createdAt: now, updatedAt: now, settledAt: null, ...overrides }
}

function fakePool(results: unknown[]) {
  let index = 0
  const client = { query: vi.fn(async (_query: unknown) => results[index++] ?? { rows: [], rowCount: null }), release: vi.fn() }
  return { pool: { connect: vi.fn(async () => client) }, client }
}

describe("tree budget reservation store", () => {
  it("locks the root, validates lineage, counts active units, and reserves one step", async () => {
    const stored = reservation()
    const { pool, client } = fakePool([
      { rows: [], rowCount: null }, { rows: [], rowCount: null },
      { rows: [{ id: "root-1", budgetSnapshot: { limits: { maxSteps: 2 } } }], rowCount: 1 },
      { rows: [], rowCount: 0 }, { rows: [{ id: "task-1" }], rowCount: 1 }, { rows: [{ units: 1 }], rowCount: 1 },
      { rows: [stored], rowCount: 1 }, { rows: [], rowCount: null },
    ])
    const result = await createPgTreeBudgetReservationStore(pool as never).reserve(input)
    expect(result).toEqual(stored)
    expect(client.query).toHaveBeenCalledTimes(8)
    const queries = client.query.mock.calls.map(call => String(call[0]))
    expect(queries[2]).toContain('FOR UPDATE')
    expect(queries[4]).toContain("step.\"status\" = 'streaming'")
    expect(queries[5]).toContain("status\" IN ('reserved', 'consumed')")
  })

  it("returns an identical reservation without consuming another unit", async () => {
    const stored = reservation({ status: "consumed", settledAt: new Date("2026-09-09T09:01:00.000Z") })
    const { pool, client } = fakePool([
      { rows: [], rowCount: null }, { rows: [], rowCount: null },
      { rows: [{ id: "root-1", budgetSnapshot: {} }], rowCount: 1 }, { rows: [stored], rowCount: 1 },
      { rows: [], rowCount: null },
    ])
    await expect(createPgTreeBudgetReservationStore(pool as never).reserve(input)).resolves.toEqual(stored)
    expect(client.query).toHaveBeenCalledTimes(5)
  })

  it("rejects a released reservation instead of reopening its identity", async () => {
    const released = reservation({ status: "released", settledAt: new Date("2026-09-09T09:01:00.000Z") })
    const { pool, client } = fakePool([
      { rows: [], rowCount: null }, { rows: [], rowCount: null },
      { rows: [{ id: "root-1", budgetSnapshot: {} }], rowCount: 1 }, { rows: [released], rowCount: 1 }, { rows: [], rowCount: null },
    ])
    await expect(createPgTreeBudgetReservationStore(pool as never).reserve(input)).rejects.toMatchObject({ code: "reservation_conflict" })
    expect(client.query).toHaveBeenCalledTimes(5)
  })

  it("fails closed when the shared step budget is exhausted", async () => {
    const { pool, client } = fakePool([
      { rows: [], rowCount: null }, { rows: [], rowCount: null },
      { rows: [{ id: "root-1", budgetSnapshot: { limits: { maxSteps: 1 } } }], rowCount: 1 },
      { rows: [], rowCount: 0 }, { rows: [{ id: "task-1" }], rowCount: 1 }, { rows: [{ units: 1 }], rowCount: 1 },
      { rows: [], rowCount: null },
    ])
    await expect(createPgTreeBudgetReservationStore(pool as never).reserve(input)).rejects.toMatchObject({ code: "tree_step_budget_exhausted" })
    expect(client.query).toHaveBeenCalledTimes(7)
  })

  it("settles reserved to consumed and makes the same transition idempotent", async () => {
    const stored = reservation()
    const consumed = reservation({ status: "consumed", settledAt: new Date("2026-09-09T09:02:00.000Z") })
    const { pool, client } = fakePool([
      { rows: [], rowCount: null }, { rows: [], rowCount: null }, { rows: [stored], rowCount: 1 }, { rows: [consumed], rowCount: 1 }, { rows: [], rowCount: null },
    ])
    const settle = { ...input, id: stored.id, status: "consumed" as const }
    await expect(createPgTreeBudgetReservationStore(pool as never).settle(settle)).resolves.toEqual(consumed)
    expect(client.query).toHaveBeenCalledTimes(5)
  })

  it("rejects a conflicting terminal transition", async () => {
    const stored = reservation({ status: "consumed" })
    const { pool } = fakePool([
      { rows: [], rowCount: null }, { rows: [], rowCount: null }, { rows: [stored], rowCount: 1 }, { rows: [], rowCount: null },
    ])
    await expect(createPgTreeBudgetReservationStore(pool as never).settle({ ...input, id: stored.id, status: "released" as const })).rejects.toMatchObject({ code: "settlement_conflict" })
    expect(new TreeBudgetStoreError("settlement_conflict")).toBeInstanceOf(Error)
  })
})
