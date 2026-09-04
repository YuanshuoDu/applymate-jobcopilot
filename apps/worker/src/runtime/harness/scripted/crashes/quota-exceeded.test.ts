import { modelFinal } from "../adapters/model.js"
import { registerScriptedTest } from "../test-compat.js"
import { createHarness, createTurn } from "../contracts/helpers.js"
import { assertCrashReplay } from "./helpers.js"

await registerScriptedTest("crash quota_exceeded fails without external writes", async () => {
  const harness = createHarness("crash-quota-exceeded")
  const result = await harness.runTurn(createTurn([modelFinal(0, "unused")], { fault: "quota_exceeded" }))
  assertCrashReplay(harness, result, "quota_exceeded", "failed", "quota_exceeded")
})
