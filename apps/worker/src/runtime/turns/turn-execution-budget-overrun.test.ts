import { describe, expect, it, vi } from "vitest"

import { BudgetExceededError, type BudgetReservation } from "../budget.js"
import type { ModelStepResult } from "./turn-engine-model.js"
import type { TurnExecutionEventWriter } from "./turn-execution-events.js"
import { settleAndPersistModelUsage } from "./turn-execution-budget-overrun.js"

const usage = { inputTokens: 2, outputTokens: 1, estimatedCostUsd: 0.02 }
const output: ModelStepResult = {
  text: "answer", reasoningSummary: "", toolCalls: [], provider: "fixture", model: "model-1",
  finishReason: "stop", usage, continuation: null,
}

function writer(append: unknown): Pick<TurnExecutionEventWriter, "append"> {
  return { append } as unknown as Pick<TurnExecutionEventWriter, "append">
}

function reservation(settle: BudgetReservation["settle"]): BudgetReservation {
  return { id: "reservation-1", settle }
}

describe("turn execution budget overrun usage persistence", () => {
  it("settles normal usage then persists exactly one receipt", async () => {
    const settle = vi.fn(), accepted = vi.fn(), append = vi.fn(async () => ({ id: "event-1" }))

    await settleAndPersistModelUsage({ reservation: reservation(settle), output, stepId: "step-1", taskId: "root-1", writer: writer(append), onUsageAccepted: accepted })

    expect(settle).toHaveBeenCalledWith(usage)
    expect(accepted).toHaveBeenCalledTimes(1)
    expect(append).toHaveBeenCalledTimes(1)
    expect(append).toHaveBeenCalledWith("model.usage", "step-1", null,
      { provider: "fixture", model: "model-1", usage, taskId: "root-1" }, "model-usage:step-1")
  })

  it("keeps an absent provider usage as null while settling zero", async () => {
    const noUsage = { ...output, usage: null }, settle = vi.fn(), accepted = vi.fn(), append = vi.fn(async () => ({ id: "event-1" }))

    await settleAndPersistModelUsage({ reservation: reservation(settle), output: noUsage, stepId: "step-1", writer: writer(append), onUsageAccepted: accepted })

    expect(settle).toHaveBeenCalledWith({ inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 })
    expect(accepted).toHaveBeenCalledTimes(1)
    expect(append).toHaveBeenCalledTimes(1)
    expect(append).toHaveBeenCalledWith("model.usage", "step-1", null, expect.objectContaining({ usage: null }), "model-usage:step-1")
  })

  it("persists accepted usage once before rethrowing a budget overrun", async () => {
    const overrun = new BudgetExceededError("input_tokens", 1, 2, 0)
    const settle = vi.fn(() => { throw overrun }), accepted = vi.fn(), append = vi.fn(async () => ({ id: "event-1" }))

    await expect(settleAndPersistModelUsage({ reservation: reservation(settle), output, stepId: "step-1", writer: writer(append), onUsageAccepted: accepted }))
      .rejects.toBe(overrun)

    expect(accepted).toHaveBeenCalledTimes(1)
    expect(append).toHaveBeenCalledTimes(1)
    expect(append).toHaveBeenCalledWith("model.usage", "step-1", null, expect.objectContaining({ usage }), "model-usage:step-1")
  })

  it("does not persist malformed usage when settlement rejects it", async () => {
    const malformed = new TypeError("input tokens must be finite and non-negative")
    const settle = vi.fn(() => { throw malformed }), accepted = vi.fn(), append = vi.fn(async () => ({ id: "event-1" }))

    await expect(settleAndPersistModelUsage({ reservation: reservation(settle), output, stepId: "step-1", writer: writer(append), onUsageAccepted: accepted }))
      .rejects.toBe(malformed)

    expect(accepted).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
  })

  it("fails closed when the receipt write fails after an overrun", async () => {
    const overrun = new BudgetExceededError("cost_usd", 0.01, 0.02, 0)
    const persistError = new Error("receipt_write_failed")
    const settle = vi.fn(() => { throw overrun }), accepted = vi.fn(), append = vi.fn(async () => { throw persistError })

    await expect(settleAndPersistModelUsage({ reservation: reservation(settle), output, stepId: "step-1", writer: writer(append), onUsageAccepted: accepted }))
      .rejects.toBe(persistError)

    expect(accepted).toHaveBeenCalledTimes(1)
    expect(append).toHaveBeenCalledTimes(1)
  })
})
