import { describe, expect, it } from "vitest"
import { taskGraphDeadlineFailureResult } from "./pg-store-task-graph-deadline-terminal.js"
import type { StoredTaskGraphNode } from "./task-graph-snapshot.js"

function node(disposition: "typed" | "specialized"): StoredTaskGraphNode {
  return { key: "analyst", taskId: "child", verificationDisposition: disposition,
    verification: disposition === "typed" ? { criteria: [{ id: "finding-count" }] } : undefined } as unknown as StoredTaskGraphNode
}

describe("TaskGraph deadline terminal result", () => {
  it("replaces stale verification metadata with a canonical typed unverified report", () => {
    const result = taskGraphDeadlineFailureResult({ workerResult: { text: "partial" }, taskGraphVerificationReport: { status: "passed" } }, node("typed"))
    expect(result).toMatchObject({ workerResult: { text: "partial" }, taskGraphVerificationReport: {
      status: "unverified", reasonCode: "result_invalid", evidenceDigest: null, resultDigest: null,
      criteria: [{ criterionId: "finding-count", status: "unverified", reasonCode: "result_invalid" }],
    } })
    expect(result).not.toHaveProperty("structuredResult")
  })

  it("preserves the stored result for specialized graph nodes", () => {
    const value = { specializedReceipt: { id: "receipt" } }
    expect(taskGraphDeadlineFailureResult(value, node("specialized"))).toBe(value)
  })
})
