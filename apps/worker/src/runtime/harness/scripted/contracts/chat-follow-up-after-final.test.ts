import assert from "node:assert/strict"

import { modelFinal } from "../adapters/model.js"
import { registerScriptedTest } from "../test-compat.js"
import { assertContractResult, createHarness, createTurn } from "./helpers.js"

await registerScriptedTest("chat accepts a follow-up after a final turn", async () => {
  const harness = createHarness("chat-follow-up-after-final")
  await harness.runTurn(createTurn([modelFinal(0, "First answer")]))
  const result = await harness.runTurn(createTurn([modelFinal(0, "Follow-up answer")]))
  assertContractResult(harness, result, "completed")
  assert.equal(result.state.turnCount, 2)
  assert.equal(harness.ledger.snapshot().filter(entry => entry.type === "turn.complete").length, 2)
})
