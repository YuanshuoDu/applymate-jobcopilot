import assert from "node:assert/strict"

import { modelFinal, modelText } from "../adapters/model.js"
import { registerScriptedTest } from "../test-compat.js"
import { assertContractResult, createHarness, createTurn } from "./helpers.js"

await registerScriptedTest("chat supports a multi-turn steering message", async () => {
  const harness = createHarness("chat-multi-turn-steer")
  await harness.runTurn(createTurn([modelText(0, "Searching Berlin roles."), modelFinal(1, "Berlin shortlist ready.")]))
  const result = await harness.runTurn(createTurn([modelText(0, "Switching to Amsterdam."), modelFinal(1, "Amsterdam shortlist ready.")]))
  assertContractResult(harness, result, "completed")
  assert.equal(result.state.turnCount, 2)
  assert.deepEqual(result.state.messages.filter(message => message.role === "assistant").map(message => message.text), ["Searching Berlin roles.", "Berlin shortlist ready.", "Switching to Amsterdam.", "Amsterdam shortlist ready."])
})
