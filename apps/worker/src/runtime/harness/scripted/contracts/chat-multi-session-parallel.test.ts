import assert from "node:assert/strict"

import { modelFinal } from "../adapters/model.js"
import { registerScriptedTest } from "../test-compat.js"
import { assertContractResult, createHarness, createTurn } from "./helpers.js"

await registerScriptedTest("chat keeps parallel sessions isolated", async () => {
  const first = createHarness("chat-multi-session-parallel-a", 42, "session-a")
  const second = createHarness("chat-multi-session-parallel-b", 42, "session-b")
  const [firstResult, secondResult] = await Promise.all([
    first.runTurn(createTurn([modelFinal(0, "A response")])),
    second.runTurn(createTurn([modelFinal(0, "B response")])),
  ])
  assertContractResult(first, firstResult, "completed")
  assertContractResult(second, secondResult, "completed")
  assert.notEqual(firstResult.state.sessionId, secondResult.state.sessionId)
  assert.equal(firstResult.state.messages.find(message => message.role === "assistant")?.text, "A response")
  assert.equal(secondResult.state.messages.find(message => message.role === "assistant")?.text, "B response")
})
