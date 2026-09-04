import { modelFinal, modelTool } from "../adapters/model.js"
import { scriptedTool } from "../adapters/tool.js"
import { registerScriptedTest } from "../test-compat.js"
import { createHarness, createTurn } from "../contracts/helpers.js"
import { assertCrashReplay } from "./helpers.js"

await registerScriptedTest("crash tool_timeout fails before the final event", async () => {
  const harness = createHarness("crash-tool-timeout")
  const tool = scriptedTool({ name: "slow-tool", response: { ok: true }, latencyMs: 10 })
  const result = await harness.runTurn(createTurn([modelTool(0, "call-2", "slow-tool", {}), modelFinal(1, "unused")], { fault: "tool_timeout", tool }))
  assertCrashReplay(harness, result, "tool_timeout", "failed", "tool_timeout")
})
