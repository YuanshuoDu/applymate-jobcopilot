import { describe, expect, it } from "vitest"

import type { TreeBudgetReservation, TreeBudgetReserveInput, TreeBudgetSettleInput } from "./tree-budget-types.js"

describe("tree budget reservation contract", () => {
  it("models one unit per model step and explicit settle transitions", () => {
    const reserve: TreeBudgetReserveInput = {
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", taskId: "task-1", stepId: "step-1", attempt: 1, idempotencyKey: "step:step-1:1",
    }
    const settle: TreeBudgetSettleInput = { ...reserve, id: "reservation-1", status: "consumed" }
    const result: TreeBudgetReservation = { ...reserve, id: "reservation-1", units: 1, status: settle.status, createdAt: new Date(), updatedAt: new Date(), settledAt: new Date() }
    expect(result.units).toBe(1)
    expect(result.status).toBe("consumed")
  })
})
