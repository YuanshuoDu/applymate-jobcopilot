import assert from "node:assert/strict"

import { registerScriptedTest } from "../test-compat.js"
import { assertContractResult, createHarness, createTurn } from "./helpers.js"

await registerScriptedTest("chat completes after approval is granted", async () => {
  const harness = createHarness("chat-approval-granted")
  const result = await harness.runTurn(createTurn([{ at: 0, event: { type: "approval_request", approvalId: "approval-2", action: "send application" } }], { approval: "approved" }))
  assertContractResult(harness, result, "completed")
  assert.equal(result.state.finalResponse, "Approved scripted completion")
  assert.ok(harness.trace().events.some(event => event.type === "approval.resolved"))
})
