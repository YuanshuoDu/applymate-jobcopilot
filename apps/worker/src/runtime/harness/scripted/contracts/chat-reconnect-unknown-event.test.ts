import assert from "node:assert/strict"

import { modelFinal } from "../adapters/model.js"
import { registerScriptedTest } from "../test-compat.js"
import { assertContractResult, createHarness, createTurn } from "./helpers.js"

await registerScriptedTest("chat records unknown protocol events without breaking reconnect", async () => {
  const harness = createHarness("chat-reconnect-unknown-event")
  const result = await harness.runTurn(createTurn([
    { at: 0, event: { type: "unknown_event", name: "future.event", payload: { version: 3 } } },
    { at: 1, event: { type: "unknown_type", name: "future.type", payload: { version: 3 } } },
    modelFinal(2, "Continued after unknown input"),
  ]))
  assertContractResult(harness, result, "completed")
  assert.equal(result.state.unknownEvents, 1)
  assert.equal(result.state.unknownTypes, 1)
})
