import assert from "node:assert/strict"

import { modelFinal } from "../adapters/model.js"
import { registerScriptedTest } from "../test-compat.js"
import { assertContractResult, createHarness, createTurn } from "./helpers.js"

await registerScriptedTest("chat surfaces the V1 deprecation banner", async () => {
  const harness = createHarness("chat-v1-deprecation-banner")
  const result = await harness.runTurn(createTurn([
    { at: 0, event: { type: "v1_banner", text: "V1 is deprecated; use the V2 stream." } },
    modelFinal(1, "V2 response"),
  ]))
  assertContractResult(harness, result, "completed")
  const banner = result.state.messages.find(message => message.role === "system")
  assert.ok(banner)
  assert.match(banner.text, /V1 is deprecated/)
})
