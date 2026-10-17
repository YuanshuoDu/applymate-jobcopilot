import { describe, expect, it, vi } from "vitest"
import type { HarnessModelRequest, ModelAdapter } from "@jobcopilot/agent-model"
import { ContextEstimateExceededError } from "./turns/model-request-admission.js"
import { preflightHarnessModelRequest } from "./harness-model-admission.js"

const profile: ModelAdapter["profile"] = {
  provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true, continuationCursor: false,
  supportsParallelTools: false, supportsStreamingToolArgs: true, supportsReasoningSummary: false,
  supportsResponseContinuation: false, supportsProviderConversation: false, supportsBackgroundResponse: false,
  maxContextTokens: 64, maxOutputTokens: 32, defaultMaxOutputTokens: 16, costClass: "unknown",
}

function request(text: string): HarnessModelRequest {
  return {
    schemaVersion: "agent-harness.v2", provider: profile.provider, model: profile.model,
    messages: [{ role: "user", content: [{ type: "text", text }] }], tools: [],
    capabilities: { nativeTools: true, structuredOutput: true, streaming: true, continuationCursor: false },
    signal: new AbortController().signal,
    metadata: { sessionId: "session-1", turnId: "turn-1", stepId: "step-1", taskId: "task-1" },
  }
}

describe("Harness request admission boundary", () => {
  it("rejects a known oversized candidate and emits only numeric route diagnostics", () => {
    const diagnostic = vi.fn(), secret = "private job history " + "x".repeat(1_000)
    let caught: unknown
    try { preflightHarnessModelRequest(request(secret), profile, { guaranteedNoProviderAttempt: true, onRequestAdmission: diagnostic }) }
    catch (error: unknown) { caught = error }

    expect(caught).toBeInstanceOf(ContextEstimateExceededError)
    expect(caught).toMatchObject({ code: "context_estimate_exceeded", provider: profile.provider, model: profile.model,
      guaranteedNoProviderAttempt: true, retryable: false, recoverable: false })
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({
      provider: profile.provider, model: profile.model, status: "known", method: "serialized_utf8_bytes_div3_ceil_plus_framing",
      estimatedInputTokens: expect.any(Number), outputReserveTokens: 16, contextWindowTokens: 64, withinWindow: false,
    }))
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(secret)
  })

  it("keeps unknown context eligible and treats diagnostic failure as best-effort", () => {
    const unknownProfile = { ...profile, maxContextTokens: null, defaultMaxOutputTokens: null }
    const diagnostic = vi.fn(() => { throw new Error("diagnostic unavailable") })
    expect(() => preflightHarnessModelRequest(request("private context"), unknownProfile, {
      guaranteedNoProviderAttempt: true, onRequestAdmission: diagnostic,
    })).not.toThrow()
    expect(diagnostic).toHaveBeenCalledWith({ provider: profile.provider, model: profile.model,
      status: "unknown", method: "unknown", estimateVersion: 1 })
  })

  it("absorbs asynchronous diagnostic rejection without delaying admission", async () => {
    const diagnostic = vi.fn(async () => { throw new Error("diagnostic unavailable") })
    const result = preflightHarnessModelRequest(request("small"), profile, {
      guaranteedNoProviderAttempt: true,
      onRequestAdmission: diagnostic,
    })

    expect(result).toMatchObject({ status: "known", withinWindow: true })
    expect(diagnostic).toHaveBeenCalledTimes(1)
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  })

  it("returns before a pending diagnostic settles", async () => {
    let resolveDiagnostic!: () => void
    const pendingDiagnostic = new Promise<void>(resolve => { resolveDiagnostic = resolve })
    const diagnostic = vi.fn(() => pendingDiagnostic)

    try {
      const result = preflightHarnessModelRequest(request("small"), profile, {
        guaranteedNoProviderAttempt: true,
        onRequestAdmission: diagnostic,
      })
      expect(result).not.toBeInstanceOf(Promise)
      expect(result).toMatchObject({ status: "known", withinWindow: true })
      expect(diagnostic).toHaveBeenCalledTimes(1)
    } finally {
      resolveDiagnostic()
    }
    await pendingDiagnostic
  })
})
