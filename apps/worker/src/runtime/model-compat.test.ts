import { describe, expect, it, vi } from "vitest"

import { createWorkerModelAdapter, workerModelCapabilityProfile } from "./model-compat.js"

const callLlm = vi.hoisted(() => vi.fn().mockResolvedValue({
  text: "worker result", inputTokens: 3, outputTokens: 2, provider: "minimax", model: "MiniMax-M3",
}))

vi.mock("@jobcopilot/shared", () => ({ callLlm }))

const config = { provider: "minimax", model: "MiniMax-M3", apiKey: "worker-secret" } as const

function request() {
  return {
    schemaVersion: "agent-harness.v2" as const,
    provider: config.provider,
    model: config.model,
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "Find jobs" }] }],
    tools: [],
    capabilities: workerModelCapabilityProfile(config),
    signal: new AbortController().signal,
    metadata: { sessionId: "s1", turnId: "t1", stepId: "p1", taskId: "k1", userId: "u1", featureId: "autoApply" },
  }
}

describe("worker model compatibility facade", () => {
  it("keeps shared callLlm as the host resolver and maps its result", async () => {
    const adapter = createWorkerModelAdapter(config)
    const response = await adapter.complete?.(request())
    expect(response).toMatchObject({ schemaVersion: "agent-harness.v2", text: "worker result", finishReason: "stop" })
    expect(response?.usage).toEqual({ inputTokens: 3, outputTokens: 2, estimatedCostUsd: 0 })
    expect(callLlm).toHaveBeenCalledWith(
      [{ role: "user", content: "Find jobs" }], config,
      { userId: "u1", featureKey: "autoApply", runtime: "worker" },
    )
  })
})
