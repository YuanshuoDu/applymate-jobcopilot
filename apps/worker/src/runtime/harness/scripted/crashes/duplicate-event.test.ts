import assert from "node:assert/strict"

import { modelFinal } from "../adapters/model.js"
import { registerScriptedTest } from "../test-compat.js"
import { createHarness, createTurn } from "../contracts/helpers.js"
import { assertCrashReplay } from "./helpers.js"

await registerScriptedTest("crash duplicate_event is idempotently ignored", async () => {
  const harness = createHarness("crash-duplicate-event")
  const result = await harness.runTurn(createTurn([modelFinal(0, "Unique response")], { fault: "duplicate_event" }))
  assertCrashReplay(harness, result, "duplicate_event", "completed")
  const ids = harness.trace().events.map(event => event.id)
  assert.equal(new Set(ids).size, ids.length)
})
