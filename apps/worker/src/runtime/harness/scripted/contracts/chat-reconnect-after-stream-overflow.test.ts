import assert from "node:assert/strict"

import { modelFinal, modelText } from "../adapters/model.js"
import { registerScriptedTest } from "../test-compat.js"
import { assertContractResult, createHarness, createTurn } from "./helpers.js"

await registerScriptedTest("chat reconnects after a stream overflow and finishes", async () => {
  const harness = createHarness("chat-reconnect-after-stream-overflow")
  const result = await harness.runTurn(createTurn([modelText(0, "Recovering stream"), modelFinal(1, "Recovered")], { fault: "network_drop" }))
  assertContractResult(harness, result, "completed")
  assert.ok(harness.trace().events.some(event => event.type === "stream.reconnected"))
  assert.equal(harness.bus.isConnected(), true)
})
