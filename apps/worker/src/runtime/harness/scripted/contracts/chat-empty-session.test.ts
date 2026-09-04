import assert from "node:assert/strict"

import { registerScriptedTest } from "../test-compat.js"
import { assertContractResult, createHarness, createTurn } from "./helpers.js"

await registerScriptedTest("chat reports an empty session deterministically", async () => {
  const harness = createHarness("chat-empty-session")
  const result = await harness.runTurn(createTurn([]))
  assertContractResult(harness, result, "empty_session")
  assert.equal(result.state.messages.length, 1)
  assert.equal(result.state.messages[0]?.role, "user")
  assert.equal(result.state.errorCode, null)
})
