import { describe, expect, it, vi } from "vitest"

import { enforceRootStepBudget, enforceRootToolCallBudget } from "./turn-engine-root-budget.js"

const owner = {
  kind: "task" as const, userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "child-1",
  rootTaskId: "root-1", ownerId: "worker-1", attemptCount: 1, leaseExpiresAt: new Date("2026-09-23T12:01:00.000Z"),
}

function client(results: unknown[]) {
  let index = 0
  return { query: vi.fn(async (_sql: string, _values?: readonly unknown[]) => results[index++] ?? { rows: [], rowCount: 0 }) }
}

describe("root budget persistence guards", () => {
  it("caps new steps against root and child steps under the tenant fence", async () => {
    const db = client([
      { rows: [{ budgetSnapshot: { limits: { maxSteps: 2 } } }] },
      { rows: [{ used: "2" }] },
    ])

    await expect(enforceRootStepBudget(db as never, owner)).rejects.toMatchObject({
      code: "budget_exhausted", metric: "steps", limit: 2, used: 2, attempted: 3,
    })
    const [rootBudgetSql, usageSql] = db.query.mock.calls.map(([sql]) => String(sql))
    expect(rootBudgetSql).toContain('session."userId" = $4')
    expect(usageSql).toContain('task."rootTaskId" = $3')
    expect(usageSql).toContain('session."userId" = $4')
  })

  it("uses the turn loop's default step ceiling when the root has no explicit limit", async () => {
    const db = client([
      { rows: [{ budgetSnapshot: {} }] },
      { rows: [{ used: "32" }] },
    ])

    await expect(enforceRootStepBudget(db as never, owner)).rejects.toMatchObject({
      code: "budget_exhausted", metric: "steps", limit: 32, used: 32, attempted: 33,
    })
  })

  it("caps root-wide tool-call creation and lets an idempotent item reach identity validation", async () => {
    const db = client([
      { rows: [] },
      { rows: [{ budgetSnapshot: { limits: { maxToolCalls: 1, maxCostUsd: 0.01 } } }] },
      { rows: [{ used: "1" }] },
    ])

    await expect(enforceRootToolCallBudget(db as never, owner, "new-call"))
      .rejects.toMatchObject({ code: "budget_exhausted", metric: "tool_calls", limit: 1, used: 1, attempted: 2 })
    expect(db.query.mock.calls.map(([sql]) => String(sql)).some(sql => sql.includes('usage_row."type" = \'tool_call\''))).toBe(true)

    const replay = client([{ rows: [{ id: "existing-call" }] }])
    await expect(enforceRootToolCallBudget(replay as never, owner, "existing-call")).resolves.toBeUndefined()
    expect(replay.query).toHaveBeenCalledOnce()
  })
})
