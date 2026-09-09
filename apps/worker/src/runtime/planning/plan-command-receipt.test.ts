import { describe, expect, it } from "vitest"

import { createPlanCommandReceipt, parsePlanCommandReceipt, planCommandObservation } from "./plan-command-receipt.js"

const valid = { planCallId: "plan-call", planRevision: 2, observationId: "plan-result:plan-call:read", content: { kind: "plan_command", status: "completed", output: { ok: true } } }

describe("plan command receipts", () => {
  it("accepts bounded server metadata and restores the same observation", () => {
    const receipt = createPlanCommandReceipt(valid)
    expect(parsePlanCommandReceipt(receipt, "plan-call", 2)).toEqual(receipt)
    expect(planCommandObservation(receipt)).toEqual({ id: valid.observationId, content: valid.content })
  })

  it("rejects malformed, unknown, mismatched, and oversized receipts", () => {
    expect(parsePlanCommandReceipt({ ...valid, extra: "identity" })).toBeNull()
    expect(parsePlanCommandReceipt({ ...valid, planCallId: "other" }, "plan-call")).toBeNull()
    expect(parsePlanCommandReceipt({ ...valid, planRevision: 3 }, "plan-call", 2)).toBeNull()
    expect(parsePlanCommandReceipt({ ...valid, observationId: " bad" })).toBeNull()
    expect(parsePlanCommandReceipt({ ...valid, content: "raw" })).toBeNull()
    expect(parsePlanCommandReceipt({ ...valid, content: { text: "x".repeat(8 * 1024) } })).toBeNull()
    expect(parsePlanCommandReceipt({ ...valid, planRevision: Number.NaN })).toBeNull()
  })
})
