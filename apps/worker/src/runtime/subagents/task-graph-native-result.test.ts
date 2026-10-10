import { describe, expect, it } from "vitest"

import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { taskGraphNativeResultReceipt } from "./task-graph-native-result.js"

const scout = {
  schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
  candidates: [], evidence: [], summary: "No candidates",
}
const envelope = {
  finalItemId: null, finalText: "No candidates", status: "completed", stepCount: 1,
  structuredResult: scout, toolCallCount: 0,
}

describe("native TaskGraph result receipt", () => {
  it("validates an explicitly declared role envelope but exposes only its digest and status", () => {
    const receipt = taskGraphNativeResultReceipt("scout", "completed", envelope, { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" })

    expect(receipt).toMatchObject({
      schemaVersion: "agent-harness.v2.task-graph.native-result.v1", role: "scout", taskStatus: "completed",
      disposition: "structured", resultDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(JSON.stringify(receipt)).not.toContain("No candidates")
    expect(JSON.stringify(receipt)).not.toContain("structuredResult")
  })

  it("fails closed on malformed or role-mismatched declared envelopes", () => {
    expect(() => taskGraphNativeResultReceipt("scout", "completed", { ...envelope, structuredResult: { ...scout, role: "analyst" } }, { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" }))
      .toThrow("task_graph_native_result_invalid")
    expect(() => taskGraphNativeResultReceipt("scout", "completed", envelope, { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst" }))
      .toThrow("task_graph_native_result_contract_invalid")
  })

  it("supports opaque Auditor results without semantic or artifact authority", () => {
    const receipt = taskGraphNativeResultReceipt("auditor", "completed", { summary: "reviewed", artifactId: "private" }, {})
    expect(receipt).toMatchObject({ role: "auditor", taskStatus: "completed", disposition: "structured" })
    expect(JSON.stringify(receipt)).not.toContain("reviewed")
    expect(JSON.stringify(receipt)).not.toContain("artifactId")
  })

  it("distinguishes missing and non-structured results", () => {
    expect(taskGraphNativeResultReceipt("executor", "failed", null, {})).toMatchObject({ disposition: "missing", resultDigest: null })
    expect(taskGraphNativeResultReceipt("executor", "completed", "finished", {})).toMatchObject({ disposition: "opaque", resultDigest: expect.stringMatching(/^[a-f0-9]{64}$/) })
  })
})
