import { modelFinal } from "../adapters/model.js"
import { registerScriptedTest } from "../test-compat.js"
import { createHarness, createTurn } from "../contracts/helpers.js"
import { assertCrashReplay } from "./helpers.js"

await registerScriptedTest("crash abort leaves an interrupted state", async () => {
  const harness = createHarness("crash-abort")
  const result = await harness.runTurn(createTurn([modelFinal(0, "unused")], { fault: "abort" }))
  assertCrashReplay(harness, result, "abort", "interrupted", "aborted")
})
