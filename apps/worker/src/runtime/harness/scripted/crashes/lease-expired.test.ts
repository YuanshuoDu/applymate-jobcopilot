import { modelFinal } from "../adapters/model.js"
import { registerScriptedTest } from "../test-compat.js"
import { createHarness, createTurn } from "../contracts/helpers.js"
import { assertCrashReplay } from "./helpers.js"

await registerScriptedTest("crash lease_expired fails with a stable error", async () => {
  const harness = createHarness("crash-lease-expired")
  const result = await harness.runTurn(createTurn([modelFinal(0, "unused")], { fault: "lease_expired" }))
  assertCrashReplay(harness, result, "lease_expired", "failed", "lease_expired")
})
