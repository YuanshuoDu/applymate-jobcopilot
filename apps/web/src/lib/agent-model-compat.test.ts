import { describe, expect, it, vi } from "vitest"

import { createWebModelAdapter, webAgentModel, webModelCapabilityProfile } from "./agent-model-compat"

const modelRouter = vi.hoisted(() => ({
  modelChat: vi.fn().mockResolvedValue({ text: "legacy result", provider: "minimax", model: "MiniMax-M3" }),
  modelChatStream: vi.fn(async function* () { yield "legacy "; yield "stream" }),
}))

vi.mock("./model-router", () => modelRouter)

const config = { provider: "minimax", model: "MiniMax-M3", apiKey: "server-secret" } as const

function request() {
  return {
    schemaVersion: "agent-harness.v2" as const,
    provider: config.provider,
    model: config.model,
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "Find jobs" }] }],
    tools: [],
    capabilities: webModelCapabilityProfile(config),
    signal: new AbortController().signal,
    metadata: { sessionId: "s1", turnId: "t1", stepId: "p1", taskId: "k1", userId: "u1", featureId: "suggest" },
  }
}

describe("web model compatibility facade", () => {
  it("delegates direct legacy chat without changing the result shape", async () => {
    const result = await webAgentModel.chat([{ role: "user", content: "Find jobs" }], config)
    expect(result).toEqual({ text: "legacy result", provider: "minimax", model: "MiniMax-M3" })
    expect(modelRouter.modelChat).toHaveBeenCalledWith([{ role: "user", content: "Find jobs" }], config, 1_024, undefined)
  })

  it("normalizes the existing string stream while preserving web usage context", async () => {
    const adapter = createWebModelAdapter(config)
    const events = []
    for await (const event of adapter.stream(request())) events.push(event)
    expect(events).toEqual([
      { type: "text_delta", text: "legacy " },
      { type: "text_delta", text: "stream" },
      { type: "completed", finishReason: "stop" },
    ])
    expect(modelRouter.modelChatStream).toHaveBeenCalledWith(
      [{ role: "user", content: "Find jobs" }], config, 1_024,
      { userId: "u1", featureKey: "suggest", runtime: "web" },
    )
  })
})
