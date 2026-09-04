import assert from "node:assert/strict"

import { modelFinal, modelText } from "../adapters/model.js"
import { registerScriptedTest } from "../test-compat.js"
import { assertContractResult, createHarness, createTurn } from "./helpers.js"

await registerScriptedTest("chat single turn completes with a final response", async () => {
  const harness = createHarness("chat-single-turn")
  const result = await harness.runTurn(createTurn([modelText(0, "I found matching roles."), modelFinal(1, "Here are the best matches.")]))
  assertContractResult(harness, result, "completed")
  assert.equal(result.state.finalResponse, "Here are the best matches.")
})
