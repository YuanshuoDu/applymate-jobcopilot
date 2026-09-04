import { modelFinal } from "../adapters/model.js"
import { registerScriptedTest } from "../test-compat.js"
import { createHarness, createTurn } from "../contracts/helpers.js"
import { assertCrashReplay } from "./helpers.js"

await registerScriptedTest("crash network_drop replays to the completed state", async () => {
  const harness = createHarness("crash-network-drop")
  const result = await harness.runTurn(createTurn([modelFinal(0, "Recovered response")], { fault: "network_drop" }))
  assertCrashReplay(harness, result, "network_drop", "completed")
})
