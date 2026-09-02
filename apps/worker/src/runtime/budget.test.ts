import { describe, expect, it } from "vitest"

import { BudgetExceededError, createTurnBudgetLedger } from "./budget.js"

describe("Turn budget ledger", () => {
  it("reserves and reconciles model usage without losing attribution", () => {
    const ledger = createTurnBudgetLedger({ maxSteps: 2, maxInputTokens: 100, maxOutputTokens: 50, maxCostUsd: 1 })
    ledger.reserveStep()
    const reservation = ledger.reserveModel({ inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.25 })
    reservation.settle({ inputTokens: 8, outputTokens: 12, estimatedCostUsd: 0.2 })
    expect(ledger.usage()).toEqual({ inputTokens: 8, outputTokens: 12, estimatedCostUsd: 0.2 })
    expect(ledger.snapshot().reserved.inputTokens).toBe(0)
  })

  it("fails before reserving work that would exceed a typed limit", () => {
    const ledger = createTurnBudgetLedger({ maxSteps: 1, maxToolCalls: 1, maxCostUsd: 0.1 })
    ledger.reserveStep()
    expect(() => ledger.reserveStep()).toThrowError(BudgetExceededError)
    expect(() => ledger.reserveToolCalls(2)).toThrowError(/tool_calls/)
    const reservation = ledger.reserveModel({ estimatedCostUsd: 0.1 })
    expect(() => reservation.settle({ inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0.2 })).toThrowError(BudgetExceededError)
  })

  it("reserves remaining provider capacity when no estimate is available", () => {
    const ledger = createTurnBudgetLedger({ maxInputTokens: 100, maxOutputTokens: 50, maxCostUsd: 1 })
    const reservation = ledger.reserveModel()
    expect(ledger.snapshot().reserved).toMatchObject({ inputTokens: 100, outputTokens: 50, estimatedCostUsd: 1 })
    reservation.settle({ inputTokens: 8, outputTokens: 12, estimatedCostUsd: 0.2 })
    expect(ledger.snapshot()).toMatchObject({ used: { inputTokens: 8, outputTokens: 12, estimatedCostUsd: 0.2 }, reserved: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } })
  })
})
