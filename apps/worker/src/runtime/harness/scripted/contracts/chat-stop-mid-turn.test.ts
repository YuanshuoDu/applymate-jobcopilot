import assert from "node:assert/strict"

import { modelFinal, modelText } from "../adapters/model.js"
import { registerScriptedTest } from "../test-compat.js"
import { assertContractResult, createHarness, createTurn } from "./helpers.js"

await registerScriptedTest("chat stop interrupts a turn before its final event", async () => {
  const harness = createHarness("chat-stop-mid-turn")
  const result = await harness.runTurn(createTurn([modelText(0, "Drafting..."), modelFinal(1, "Should not arrive")], { stopAt: 1 }))
  assertContractResult(harness, result, "interrupted", "interrupt_requested")
  assert.equal(result.state.finalResponse, null)
  assert.ok(harness.trace().events.some(event => event.type === "turn.interrupted"))
})
