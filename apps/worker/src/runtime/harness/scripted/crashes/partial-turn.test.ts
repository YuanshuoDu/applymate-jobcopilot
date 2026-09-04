import { modelFinal } from "../adapters/model.js"
import { registerScriptedTest } from "../test-compat.js"
import { createHarness, createTurn } from "../contracts/helpers.js"
import { assertCrashReplay } from "./helpers.js"

await registerScriptedTest("crash partial_turn preserves the partial output and failure", async () => {
  const harness = createHarness("crash-partial-turn")
  const result = await harness.runTurn(createTurn([modelFinal(0, "unused")], { fault: "partial_turn" }))
  assertCrashReplay(harness, result, "partial_turn", "failed", "partial_turn")
})
