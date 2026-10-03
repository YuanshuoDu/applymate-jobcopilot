import { describe, expect, it, vi } from "vitest"

import { enforceRootStepBudget, enforceRootToolCallBudget, enforceRootUsageBudget } from "./turn-engine-root-budget.js"

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

  it("does not run a token or cost SUM when the root has no usage limits", async () => {
    const db = client([{ rows: [{ budgetSnapshot: { limits: { maxSteps: 4, maxToolCalls: 2 } } }] }])

    await expect(enforceRootUsageBudget(db as never, owner)).resolves.toBeUndefined()
    expect(db.query).toHaveBeenCalledOnce()
    expect(String(db.query.mock.calls[0]?.[0])).not.toContain("SUM(")
  })

  it.each([
    { limit: "maxInputTokens", column: "inputTokens", metric: "input_tokens", used: "5" },
    { limit: "maxOutputTokens", column: "outputTokens", metric: "output_tokens", used: "6" },
    { limit: "maxCostUsd", column: "estimatedCostUsd", metric: "cost_usd", used: "0.25" },
  ] as const)("post-commit guard blocks the next step at $limit equality (not a strict cap)", async ({ limit, column, metric, used }) => {
    // The SUM is already committed usage; reaching the limit blocks a later step.
    const configuredLimit = limit === "maxCostUsd" ? 0.25 : Number(used)
    const db = client([
      { rows: [{ budgetSnapshot: { limits: { [limit]: configuredLimit } } }] },
      { rows: [{ [column]: used }] },
    ])

    await expect(enforceRootUsageBudget(db as never, owner)).rejects.toMatchObject({
      code: "budget_exhausted", metric, limit: configuredLimit, used: Number(used), attempted: Number(used),
    })
    const [rootBudgetSql, aggregateSql] = db.query.mock.calls.map(([sql]) => String(sql))
    expect(rootBudgetSql).toContain('session."userId" = $4')
    expect(aggregateSql).toContain(`SUM(usage_row."${column}")`)
    expect(aggregateSql).toContain('task."rootTaskId" = $3')
    expect(aggregateSql).toContain('session."userId" = $4')
    expect(aggregateSql).toContain('task."turnId" = usage_row."turnId"')
    expect(db.query.mock.calls[1]?.[1]).toEqual([owner.sessionId, owner.turnId, owner.rootTaskId, owner.userId])
  })

  it("accepts the legacy flat snapshot shape and treats a null SUM as zero", async () => {
    const db = client([
      { rows: [{ budgetSnapshot: { maxInputTokens: 1 } }] },
      { rows: [{ inputTokens: null }] },
    ])

    await expect(enforceRootUsageBudget(db as never, owner)).resolves.toBeUndefined()
  })

  it("falls back to the legacy flat shape when limits is null", async () => {
    const db = client([
      { rows: [{ budgetSnapshot: { limits: null, maxInputTokens: 1 } }] },
      { rows: [{ inputTokens: null }] },
    ])

    await expect(enforceRootUsageBudget(db as never, owner)).resolves.toBeUndefined()
  })

  it("accepts fractional token thresholds while requiring integer committed token usage", async () => {
    const db = client([
      { rows: [{ budgetSnapshot: { limits: { maxInputTokens: 1.5 } } }] },
      { rows: [{ inputTokens: "2" }] },
    ])

    await expect(enforceRootUsageBudget(db as never, owner)).rejects.toMatchObject({
      code: "budget_exhausted", metric: "input_tokens", limit: 1.5, used: 2,
    })
  })

  it.each([
    ["maxInputTokens", -1],
    ["maxInputTokens", Number.NaN],
    ["maxOutputTokens", "4"],
    ["maxOutputTokens", null],
    ["maxCostUsd", -0.1],
    ["maxCostUsd", Number.POSITIVE_INFINITY],
    ["maxCostUsd", "0.1"],
  ] as const)("fails closed for malformed %s limit %s", async (limit, value) => {
    const db = client([{ rows: [{ budgetSnapshot: { limits: { [limit]: value } } }] }])

    await expect(enforceRootUsageBudget(db as never, owner)).rejects.toThrow("turn_budget_limit_invalid")
    expect(db.query).toHaveBeenCalledOnce()
  })

  it.each(["invalid", 4, false, []] as const)("fails closed for malformed non-null limits container %s", async limits => {
    const db = client([{ rows: [{ budgetSnapshot: { limits } }] }])

    await expect(enforceRootUsageBudget(db as never, owner)).rejects.toThrow("turn_budget_limit_invalid")
    expect(db.query).toHaveBeenCalledOnce()
  })

  it.each([
    { limit: "maxInputTokens", column: "inputTokens", value: -1 },
    { limit: "maxInputTokens", column: "inputTokens", value: "1.5" },
    { limit: "maxInputTokens", column: "inputTokens", value: "9007199254740992" },
    { limit: "maxOutputTokens", column: "outputTokens", value: Number.NaN },
    { limit: "maxCostUsd", column: "estimatedCostUsd", value: -0.01 },
    { limit: "maxCostUsd", column: "estimatedCostUsd", value: "Infinity" },
    { limit: "maxCostUsd", column: "estimatedCostUsd", value: true },
  ] as const)("fails closed for malformed $column usage aggregates", async ({ limit, column, value }) => {
    const db = client([
      { rows: [{ budgetSnapshot: { limits: { [limit]: 100 } } }] },
      { rows: [{ [column]: value }] },
    ])

    await expect(enforceRootUsageBudget(db as never, owner)).rejects.toThrow("turn_budget_usage_invalid")
  })

  it("fails closed when a configured aggregate query has no SUM row", async () => {
    const db = client([
      { rows: [{ budgetSnapshot: { limits: { maxCostUsd: 1 } } }] },
      { rows: [] },
    ])

    await expect(enforceRootUsageBudget(db as never, owner)).rejects.toThrow("turn_budget_usage_invalid")
  })
})
