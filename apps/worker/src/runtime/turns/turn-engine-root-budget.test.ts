import { describe, expect, it, vi } from "vitest"

import { enforceRootStepAndUsageBudgets, enforceRootStepBudget, enforceRootToolCallBudget, enforceRootUsageBudget, readCurrentRootBudget } from "./turn-engine-root-budget.js"

const owner = {
  kind: "task" as const, userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "child-1",
  rootTaskId: "root-1", ownerId: "worker-1", attemptCount: 1, leaseExpiresAt: new Date("2026-09-23T12:01:00.000Z"),
}

function client(results: unknown[]) {
  let index = 0
  return { query: vi.fn(async (sql: string, _values?: readonly unknown[]) => {
    if (sql === "SELECT set_config('app.user_id', $1, true)") return { rows: [], rowCount: 1 }
    return results[index++] ?? { rows: [], rowCount: 0 }
  }) }
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

  it("preserves the default step ceiling for a malformed maxSteps value", async () => {
    const db = client([
      { rows: [{ budgetSnapshot: { limits: { maxSteps: "32" } } }] },
      { rows: [{ used: "32" }] },
    ])

    await expect(enforceRootStepBudget(db as never, owner)).rejects.toMatchObject({
      code: "budget_exhausted", metric: "steps", limit: 32, used: 32, attempted: 33,
    })
  })

  it.each([
    { maxSteps: 2, used: 2 },
    { maxSteps: 3, used: 2 },
  ])("requires both continuation steps with shared usage $used/$maxSteps", async ({ maxSteps, used }) => {
    const db = client([
      { rows: [{ budgetSnapshot: { limits: { maxSteps } } }] },
      { rows: [{ used: String(used) }] },
    ])

    await expect(enforceRootStepBudget(db as never, owner, 2)).rejects.toMatchObject({
      code: "budget_exhausted", metric: "steps", limit: maxSteps, used, attempted: used + 2,
    })
    expect(db.query).toHaveBeenCalledTimes(2)
  })

  it("admits exactly two shared steps from a locked root planning scope", async () => {
    const db = client([
      { rows: [{ budgetSnapshot: { limits: { maxSteps: 4 } } }] },
      { rows: [{ used: "2" }] },
    ])
    const rootScope = {
      kind: "turn" as const, userId: "user-1", sessionId: "session-1", turnId: "turn-1",
      taskId: "root-1", rootTaskId: "root-1",
    }

    await expect(enforceRootStepBudget(db as never, rootScope, 2)).resolves.toBeUndefined()
    expect(db.query).toHaveBeenCalledTimes(2)
    expect(db.query.mock.calls[0]?.[1]).toEqual(["root-1", "session-1", "turn-1", "user-1"])
    expect(db.query.mock.calls[1]?.[1]).toEqual(["session-1", "turn-1", "root-1", "user-1"])
    expect(String(db.query.mock.calls[1]?.[0])).toContain('task."rootTaskId" = $3')
    expect(String(db.query.mock.calls[1]?.[0])).toContain('session."userId" = $4')
  })

  it.each([0, 3, 1.5, null, "2"] as const)("rejects invalid requiredSteps %s before querying", async requiredSteps => {
    const db = client([])
    const callWithUnknownRequiredSteps = enforceRootStepBudget as unknown as (
      queryClient: unknown, scope: typeof owner, steps: unknown,
    ) => Promise<void>

    await expect(callWithUnknownRequiredSteps(db, owner, requiredSteps)).rejects.toThrow("root_step_budget_required_steps_invalid")
    expect(db.query).not.toHaveBeenCalled()
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

  it("checks step and absent usage limits from one root snapshot", async () => {
    const db = client([
      { rows: [{ budgetSnapshot: { limits: { maxSteps: 4, maxToolCalls: 2 } } }] },
      { rows: [{ used: "0" }] },
    ])

    await expect(enforceRootStepAndUsageBudgets(db as never, owner)).resolves.toBeUndefined()
    expect(db.query).toHaveBeenCalledTimes(2)
    expect(String(db.query.mock.calls[0]?.[0])).toContain('SELECT root_task."budgetSnapshot"')
    expect(String(db.query.mock.calls[1]?.[0])).toContain('COUNT(*)::bigint AS "used"')
    expect(db.query.mock.calls.map(([sql]) => String(sql)).some(sql => sql.includes("SUM("))).toBe(false)
  })

  it("blocks the next step at the maxSteps boundary before usage aggregation", async () => {
    const db = client([
      { rows: [{ budgetSnapshot: { limits: { maxSteps: 1, maxCostUsd: 0 } } }] },
      { rows: [{ used: "1" }] },
    ])

    await expect(enforceRootStepAndUsageBudgets(db as never, owner)).rejects.toMatchObject({
      code: "budget_exhausted", metric: "steps", limit: 1, used: 1, attempted: 2,
    })
    expect(db.query).toHaveBeenCalledTimes(2)
    expect(String(db.query.mock.calls[0]?.[0])).toContain('SELECT root_task."budgetSnapshot"')
    expect(String(db.query.mock.calls[1]?.[0])).toContain('COUNT(*)::bigint AS "used"')
    expect(db.query.mock.calls.map(([sql]) => String(sql)).some(sql => sql.includes("SUM("))).toBe(false)
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

describe("current shared Root budget observation", () => {
  it("reads the current step, descendant/null-task usage and limits in one read-only repeatable snapshot", async () => {
    const db = client([
      { rows: [], rowCount: 0 },
      { rows: [{ budgetSnapshot: { limits: { maxSteps: 10, maxToolCalls: 8, maxInputTokens: 100, maxOutputTokens: 200, maxCostUsd: 0.5 } } }] },
      { rows: [{ used: "4" }] }, { rows: [{ used: "7" }] },
      { rows: [{ inputTokens: "20", outputTokens: "30", estimatedCostUsd: "0.125" }] },
      { rows: [], rowCount: 0 },
    ])

    const budget = await readCurrentRootBudget(db as never, owner)

    expect(budget).toEqual({ kind: "turn_budget_current", status: "available", advisoryOnly: true, pointInTime: true,
      notPermission: true, notReservation: true, notCompletionEvidence: true, budgets: {
        steps: { limit: 10, used: 4, remaining: 6 }, toolCalls: { limit: 8, used: 7, remaining: 1 },
        inputTokens: { limit: 100, used: 20, remaining: 80 }, outputTokens: { limit: 200, used: 30, remaining: 170 },
        costUsd: { limit: 0.5, used: 0.125, remaining: 0.375 },
      } })
    const calls = db.query.mock.calls.map(([sql, values]) => ({ sql: String(sql), values }))
    expect(calls.map(call => call.sql)).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SELECT set_config('app.user_id', $1, true)",
      expect.stringContaining('SELECT root_task."budgetSnapshot"'),
      expect.stringContaining('COUNT(*)::bigint'),
      expect.stringContaining('COUNT(*)::bigint'),
      expect.stringContaining('SUM(usage_row."inputTokens")'),
      "COMMIT",
    ])
    expect(calls[1]?.values).toEqual([owner.userId])
    expect(calls[2]?.sql).toContain('root_task."rootTaskId" = root_task."id"')
    expect(calls[2]?.sql).toContain('session."userId" = $4')
    for (const call of calls.slice(3, 6)) {
      expect(call.sql).toContain('usage_row."sessionId" = $1')
      expect(call.sql).toContain('usage_row."turnId" = $2')
      expect(call.sql).toContain('task."rootTaskId" = $3')
      expect(call.sql).toContain('session."userId" = $4')
      expect(call.values).toEqual([owner.sessionId, owner.turnId, owner.rootTaskId, owner.userId])
    }
    expect(calls[4]?.sql).toContain("usage_row.\"type\" = 'tool_call'")
    expect(calls[5]?.sql).toContain('SUM(usage_row."inputTokens")')
  })

  it("shows default steps and explicit unbounded dimensions instead of inventing optional caps", async () => {
    const db = client([
      { rows: [] }, { rows: [{ budgetSnapshot: {} }] }, { rows: [{ used: "32" }] },
      { rows: [{ used: "0" }] }, { rows: [{ inputTokens: "0", outputTokens: "0", estimatedCostUsd: "0" }] }, { rows: [] },
    ])

    await expect(readCurrentRootBudget(db as never, owner)).resolves.toMatchObject({ status: "available", budgets: {
      steps: { limit: 32, used: 32, remaining: 0 }, toolCalls: { limit: null, used: 0, remaining: null },
      inputTokens: { limit: null, used: 0, remaining: null }, outputTokens: { limit: null, used: 0, remaining: null },
      costUsd: { limit: null, used: 0, remaining: null },
    } })
  })

  it.each([
    { root: { rows: [] }, counts: [] },
    { root: { rows: [{ budgetSnapshot: { limits: { maxSteps: "3" } } }] }, counts: [] },
    { root: { rows: [{ budgetSnapshot: { limits: [] } }] }, counts: [] },
    { root: { rows: [{ budgetSnapshot: {} }] }, counts: [{ rows: [{ used: "bad" }] }] },
    ...[null, "", " ", true, -1, Number.MAX_SAFE_INTEGER + 1, "9007199254740992"].map(used => ({
      root: { rows: [{ budgetSnapshot: {} }] }, counts: [{ rows: [{ used }] }],
    })),
    { root: { rows: [{ budgetSnapshot: {} }] }, counts: [{ rows: [{ used: "1" }] }, { rows: [{ used: "0" }] }, { rows: [{ inputTokens: "1.5", outputTokens: "0", estimatedCostUsd: "0" }] }] },
  ])("fails closed as unavailable for missing ownership or malformed budget state", async ({ root, counts }) => {
    const db = client([{ rows: [] }, root, ...counts, { rows: [] }])
    await expect(readCurrentRootBudget(db as never, owner)).resolves.toMatchObject({ kind: "turn_budget_current", status: "unavailable" })
    expect(db.query.mock.calls[0]?.[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
    expect(db.query.mock.calls[1]).toEqual(["SELECT set_config('app.user_id', $1, true)", [owner.userId]])
    expect(String(db.query.mock.calls[2]?.[0])).toContain('SELECT root_task."budgetSnapshot"')
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("COMMIT")
  })

  it("rolls back and propagates a failed snapshot read without emitting fabricated usage", async () => {
    const db = { query: vi.fn(async (sql: string) => {
      if (sql === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY") return { rows: [] }
      if (sql.includes('SELECT root_task."budgetSnapshot"')) throw new Error("read_failed")
      return { rows: [] }
    }) }
    await expect(readCurrentRootBudget(db as never, owner)).rejects.toThrow("read_failed")
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK")
  })
})
