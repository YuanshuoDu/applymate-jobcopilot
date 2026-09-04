import assert from "node:assert/strict"

import { modelFinal, ScriptedHarness } from "./index.js"
import { registerScriptedTest } from "./test-compat.js"

await registerScriptedTest("scripted harness public index exports the DSL", () => {
  assert.equal(typeof ScriptedHarness, "function")
  assert.equal(modelFinal(0, "ok").event.type, "final")
})
