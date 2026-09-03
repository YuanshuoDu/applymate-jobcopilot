import { describe, expect, it, vi } from "vitest"

import { AgentModelError, MODEL_SCHEMA_VERSION, type HarnessModelRequest } from "@jobcopilot/agent-model"

import { rerouteAfterCursorLoss } from "./context-cursor-reroute.js"

const request: HarnessModelRequest = {
  schemaVersion: MODEL_SCHEMA_VERSION,
  provider: "minimax",
  model: "MiniMax-M3",
  messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
  tools: [],
  capabilities: { nativeTools: true, structuredOutput: false, streaming: true, continuationCursor: true },
  continuation: { cursor: "provider-cursor", providerResponseId: "response-1" },
  signal: new AbortController().signal,
  metadata: { sessionId: "session-a", turnId: "turn-a", stepId: "step-a", taskId: "task-a" },
}

describe("provider cursor loss reroute", () => {
  it("loads canonical messages and invokes the next provider without stale cursor state", async () => {
    const canonical = [{ role: "system" as const, content: [{ type: "text" as const, text: "Canonical" }] }, ...request.messages]
    const invoke = vi.fn(async (rerouted: HarnessModelRequest) => rerouted.provider)
    const result = await rerouteAfterCursorLoss({
      request,
      failure: new AgentModelError({ code: "cursor_lost", message: "lost", recoverable: true }),
      loadCanonicalMessages: vi.fn(async () => canonical),
      selectProvider: (rerouted) => ({ ...rerouted, provider: "anthropic", model: "claude-test" }),
      invoke,
    })

    expect(result.value).toBe("anthropic")
    expect(result.recovery.request.continuation).toBeUndefined()
    expect(result.recovery.request.messages).toEqual(canonical)
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ messages: canonical }))
    expect("continuation" in invoke.mock.calls[0][0]).toBe(false)
  })

  it("does not reroute an untyped failure", async () => {
    await expect(rerouteAfterCursorLoss({
      request,
      failure: new Error("cursor lost"),
      loadCanonicalMessages: vi.fn(async () => request.messages),
      invoke: vi.fn(),
    })).rejects.toThrow(/Only a cursor_lost/)
  })
})
