import assert from "node:assert/strict"

import { registerScriptedTest } from "../test-compat.js"
import { scriptedClock } from "./clock.js"
import { scriptedTool, ScriptedToolError } from "./tool.js"

await registerScriptedTest("scripted tool records calls and deterministic timeout", async () => {
  const clock = scriptedClock({ start: "2026-01-01T00:00:00.000Z" })
  const tool = scriptedTool({ name: "draft", response: { saved: true }, latencyMs: 10 })
  await assert.rejects(tool.execute({ id: "draft-1" }, { clock, timeoutMs: 0 }), ScriptedToolError)
  assert.equal(tool.invocations.length, 1)
  assert.equal(clock.nowIso(), "2026-01-01T00:00:00.010Z")
})
