import assert from "node:assert/strict"

import { modelFinal, modelText } from "../adapters/model.js"
import { registerScriptedTest } from "../test-compat.js"
import { assertContractResult, createHarness, createTurn } from "./helpers.js"

await registerScriptedTest("contract helpers enforce the shared assertions", async () => {
  const harness = createHarness("helper-test")
  const result = await harness.runTurn(createTurn([modelText(0, "hello"), modelFinal(1, "done")]))
  assertContractResult(harness, result, "completed")
  assert.deepEqual(result.state.messages.map(message => message.text), ["scripted job-search task", "hello", "done"])
})
