import { describe, expect, it } from "vitest"

import { AgentModelError } from "../errors.js"
import { MODEL_SCHEMA_VERSION, type HarnessModelRequest } from "../contracts.js"
import { isCursorLoss, rebuildAfterCursorLoss } from "./recovery.js"

const request: HarnessModelRequest = {
  schemaVersion: MODEL_SCHEMA_VERSION,
  provider: "openai-compatible",
  model: "gpt-test",
  messages: [{ role: "user", content: [{ type: "text", text: "Find jobs" }] }],
  tools: [],
  capabilities: { nativeTools: true, structuredOutput: true, streaming: true, continuationCursor: true },
  continuation: { providerResponseId: "resp-1", cursor: "resp-1" },
  signal: new AbortController().signal,
  metadata: { sessionId: "session-1", turnId: "turn-1", stepId: "step-2", taskId: "task-1" },
}

describe("cursor-loss context recovery", () => {
  it("rebuilds the request from canonical history and removes provider cursor state", () => {
    const failure = new AgentModelError({
      code: "cursor_lost", message: "Provider continuation cursor is no longer valid",
      provider: request.provider, model: request.model, recoverable: true,
    })
    const canonicalMessages = [
      { role: "system" as const, content: [{ type: "text" as const, text: "Safety" }] },
      ...request.messages,
      { role: "assistant" as const, content: [{ type: "text" as const, text: "I will search." }] },
    ]
    const result = rebuildAfterCursorLoss(request, canonicalMessages, failure)
    expect(result.request).toMatchObject({ messages: canonicalMessages, provider: request.provider })
    expect(result.request.continuation).toBeUndefined()
    expect(result).toMatchObject({ reason: "cursor_lost", failure: { code: "cursor_lost" }, previousContinuation: request.continuation })
    expect(result.request.messages).not.toBe(canonicalMessages)
    expect(result.request.messages[0]?.content).not.toBe(canonicalMessages[0]?.content)
  })

  it("only accepts typed cursor loss as a recovery trigger", () => {
    expect(isCursorLoss(new Error("cursor lost"))).toBe(false)
    expect(() => rebuildAfterCursorLoss(request, request.messages, new Error("cursor lost"))).toThrow(/Only a cursor_lost/)
    expect(() => rebuildAfterCursorLoss(request, [], new AgentModelError({ code: "cursor_lost", message: "lost" }))).toThrow(/Canonical context/)
  })
})
