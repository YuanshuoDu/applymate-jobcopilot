import assert from "node:assert/strict"

import { registerScriptedTest } from "./test-compat.js"

await registerScriptedTest("script compatibility registers a test in the active runner", () => {
  assert.equal(typeof registerScriptedTest, "function")
})
