import assert from "node:assert/strict"

import { registerScriptedTest } from "../test-compat.js"
import { assertContractResult, createHarness, createTurn } from "./helpers.js"

await registerScriptedTest("chat interrupts after approval is denied", async () => {
  const harness = createHarness("chat-approval-denied")
  const result = await harness.runTurn(createTurn([{ at: 0, event: { type: "approval_request", approvalId: "approval-3", action: "submit application" } }], { approval: "rejected" }))
  assertContractResult(harness, result, "interrupted")
  assert.equal(result.state.finalResponse, null)
  assert.ok(harness.ledger.snapshot().some(entry => entry.type === "approval.consume" && entry.payload !== null && typeof entry.payload === "object" && "decision" in entry.payload && entry.payload.decision === "rejected"))
})
