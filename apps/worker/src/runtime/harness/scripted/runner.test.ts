import assert from "node:assert/strict"

import { modelFinal, modelText, scriptedModel } from "./adapters/model.js"
import { registerScriptedTest } from "./test-compat.js"
import { ScriptedHarness } from "./runner.js"

await registerScriptedTest("scripted harness can run a session with two turns", async () => {
  const harness = new ScriptedHarness({ scenario: "runner-test", seed: 7, sessionId: "runner-session" })
  const state = await harness.runSession([
    { goal: "first", model: scriptedModel({ steps: [modelFinal(0, "one")] }) },
    { goal: "second", model: scriptedModel({ steps: [modelFinal(0, "two")] }) },
  ])
  assert.equal(state.status, "completed")
  assert.equal(state.turnCount, 2)
  assert.equal(state.messages.length, 4)

  const timed = new ScriptedHarness({ scenario: "runner-time-test", seed: 8 })
  const timedResult = await timed.runTurn({
    goal: "timed",
    model: scriptedModel({ steps: [modelText({ timeMs: 50 }, "timed output"), modelFinal({ timeMs: 75 }, "timed final")] }),
  })
  assert.equal(timedResult.status, "completed")
  assert.equal(timed.clock.nowIso(), "2026-01-01T00:00:00.075Z")
})
