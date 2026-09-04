import assert from "node:assert/strict"

import { registerScriptedTest } from "../test-compat.js"
import { assertContractResult, createHarness, createTurn } from "./helpers.js"

await registerScriptedTest("chat pauses on an approval request", async () => {
  const harness = createHarness("chat-approval-request")
  const result = await harness.runTurn(createTurn([{ at: 0, event: { type: "approval_request", approvalId: "approval-1", action: "send application" } }]))
  assertContractResult(harness, result, "waiting_for_approval")
  assert.deepEqual(harness.ledger.snapshot().filter(entry => entry.type === "approval.consume").at(-1)?.payload, { decision: "not_required" })
})
