import { describe, expect, it } from "vitest"
import { OBJECTIVE_SLOT_REVIEWER_RECEIPT_SCHEMA, parseObjectiveSlotReviewerReceiptResponse } from "./objective-slot-reviewer-receipt-contract"

const receipt = { schemaVersion: OBJECTIVE_SLOT_REVIEWER_RECEIPT_SCHEMA, graphRevision: 7, slotOrdinal: 2,
  artifactVersion: 3, outcome: "passed" as const, receiptKey: `review-${"a".repeat(64)}` }
const response = { reviewerReceipt: receipt }

describe("Objective Reviewer receipt browser contract", () => {
  it("parses only the closed inner receipt projection", () => {
    expect(parseObjectiveSlotReviewerReceiptResponse(response, { graphRevision: 7, slotOrdinal: 2 })).toEqual(receipt)
    expect(parseObjectiveSlotReviewerReceiptResponse({ ...response, extra: true }, { graphRevision: 7, slotOrdinal: 2 })).toBeNull()
    expect(parseObjectiveSlotReviewerReceiptResponse({ reviewerReceipt: { ...receipt, extra: true } }, { graphRevision: 7, slotOrdinal: 2 })).toBeNull()
  })

  it.each([
    ["wrong graph", { ...response, reviewerReceipt: { ...receipt, graphRevision: 8 } }],
    ["wrong slot", { ...response, reviewerReceipt: { ...receipt, slotOrdinal: 1 } }],
    ["wrong outcome", { ...response, reviewerReceipt: { ...receipt, outcome: "failed" } }],
    ["wrong key", { ...response, reviewerReceipt: { ...receipt, receiptKey: "review-bad" } }],
    ["wrong version", { ...response, reviewerReceipt: { ...receipt, artifactVersion: 0 } }],
  ])("rejects %s", (_label, value) => {
    expect(parseObjectiveSlotReviewerReceiptResponse(value, { graphRevision: 7, slotOrdinal: 2 })).toBeNull()
  })

  it("rejects accessor-backed envelopes", () => {
    const value: Record<string, unknown> = {}
    Object.defineProperty(value, "reviewerReceipt", { enumerable: true, get: () => receipt })
    expect(parseObjectiveSlotReviewerReceiptResponse(value, { graphRevision: 7, slotOrdinal: 2 })).toBeNull()
  })
})
