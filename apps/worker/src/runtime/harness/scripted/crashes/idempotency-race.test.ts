import assert from "node:assert/strict"

import { modelFinal, modelTool } from "../adapters/model.js"
import { scriptedTool } from "../adapters/tool.js"
import { registerScriptedTest } from "../test-compat.js"
import { createHarness, createTurn } from "../contracts/helpers.js"
import { assertCrashReplay } from "./helpers.js"

await registerScriptedTest("crash idempotency_race executes twice but commits one ledger effect", async () => {
  const harness = createHarness("crash-idempotency-race")
  const tool = scriptedTool({ name: "save-draft", response: { saved: true }, latencyMs: 5 })
  const result = await harness.runTurn(createTurn([modelTool(0, "call-1", "save-draft", { draftId: "draft-1" }), modelFinal(1, "Draft saved")], { fault: "idempotency_race", tool }))
  assertCrashReplay(harness, result, "idempotency_race", "completed")
  assert.equal(tool.invocations.length, 2)
  assert.equal(harness.ledger.snapshot().filter(entry => entry.type === "tool.execution").length, 1)
})
