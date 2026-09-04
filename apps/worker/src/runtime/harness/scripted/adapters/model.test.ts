import assert from "node:assert/strict"

import { registerScriptedTest } from "../test-compat.js"
import { modelFinal, modelText, scriptedModel } from "./model.js"

await registerScriptedTest("scripted model gates sequence and clock steps", () => {
  const model = scriptedModel({ steps: [modelFinal({ timeMs: 50 }, "done"), modelText(0, "start")] })
  assert.equal(model.next(0, 0)?.event.type, "text")
  assert.equal(model.next(1, 25), null)
  assert.equal(model.next(1, 50)?.event.type, "final")
  model.reset()
  assert.equal(model.next(0, 0)?.event.type, "text")
})
