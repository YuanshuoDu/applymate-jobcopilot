import assert from "node:assert/strict"

import { modelFinal, modelText } from "./adapters/model.js"
import { createHarness, createTurn } from "./contracts/helpers.js"
import { registerScriptedTest } from "./test-compat.js"
import { replayHarnessTrace } from "./replay.js"

await registerScriptedTest("trace replay reconstructs the exact final reducer state", async () => {
  const harness = createHarness("replay-test")
  await harness.runTurn(createTurn([modelText(0, "replay me"), modelFinal(1, "replayed")]))
  const trace = harness.trace()
  assert.deepEqual(replayHarnessTrace(trace), trace.finalState)
})
