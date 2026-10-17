import { describe, expect, it } from "vitest"
import { AgentModelError, MODEL_SCHEMA_VERSION, type HarnessModelRequest, type ModelCapabilityProfile } from "@jobcopilot/agent-model"
import { Type } from "@sinclair/typebox"

import { ToolRegistry } from "../tools/registry.js"
import type { RuntimeToolDefinition } from "../tools/types.js"
import { buildModelRequest } from "./turn-engine-messages.js"
import type { StepContext } from "../context/step-context-builder.js"
import type { ModelAdapter } from "@jobcopilot/agent-model"
import {
  ContextEstimateExceededError,
  estimateModelRequestAdmission,
  MODEL_REQUEST_ADMISSION_ESTIMATE_VERSION,
  MODEL_REQUEST_ADMISSION_METHOD,
  type ModelRequestAdmissionEstimate,
} from "./model-request-admission.js"

const profile: ModelCapabilityProfile = {
  provider: "minimax", model: "MiniMax-M3", nativeTools: true, structuredOutput: true,
  streaming: true, continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: true,
  supportsReasoningSummary: true, supportsResponseContinuation: false, supportsProviderConversation: false,
  supportsBackgroundResponse: false, maxContextTokens: 16_000, maxOutputTokens: 4_096,
  defaultMaxOutputTokens: 128, costClass: "low",
}

function request(overrides: Partial<HarnessModelRequest> = {}): HarnessModelRequest {
  return {
    schemaVersion: MODEL_SCHEMA_VERSION,
    provider: profile.provider,
    model: profile.model,
    messages: [{ role: "user", content: [{ type: "text", text: "abc" }] }],
    tools: [],
    capabilities: { nativeTools: true, structuredOutput: true, streaming: true, continuationCursor: false },
    signal: new AbortController().signal,
    metadata: { sessionId: "session", turnId: "turn", stepId: "step", taskId: "task" },
    ...overrides,
  }
}

function known(result: ModelRequestAdmissionEstimate): Extract<ModelRequestAdmissionEstimate, { status: "known" }> {
  if (result.status !== "known") throw new Error(`Expected a known estimate; received ${result.reason}`)
  return result
}

describe("full model request context estimate", () => {
  it("uses a versioned UTF-8 estimate and counts messages, multipart tool use/results, tools, and schema", () => {
    const base = known(estimateModelRequestAdmission(request(), profile))
    const complete = known(estimateModelRequestAdmission(request({
      messages: [{ role: "assistant", content: [
        { type: "text", text: "Résumé 😀" },
        { type: "tool_use", id: "call-1", name: "search", input: { query: "Berlin roles" } },
        { type: "tool_result", toolUseId: "call-1", content: "Found three roles", isError: false },
      ] }],
      tools: [{ name: "search", description: "Search roles", parameters: { type: "object", properties: { query: { type: "string" } } } }],
      outputSchema: { type: "object", properties: { summary: { type: "string" } } },
      toolChoice: { name: "search" },
    }), profile))

    expect(base).toMatchObject({
      status: "known", estimateVersion: MODEL_REQUEST_ADMISSION_ESTIMATE_VERSION,
      method: MODEL_REQUEST_ADMISSION_METHOD, outputReserveTokens: 128,
    })
    expect(complete.estimatedInputTokens).toBeGreaterThan(base.estimatedInputTokens)
    expect(complete.withinWindow).toBe(true)
  })

  it("counts UTF-8 bytes for Unicode text and includes an explicit framing allowance", () => {
    const ascii = known(estimateModelRequestAdmission(request({
      messages: [{ role: "user", content: [{ type: "text", text: "a" }] }],
    }), profile))
    const unicode = known(estimateModelRequestAdmission(request({
      messages: [{ role: "user", content: [{ type: "text", text: "😀" }] }],
    }), profile))
    expect(unicode.estimatedInputTokens).toBe(ascii.estimatedInputTokens + 1)
  })

  it("is deterministic across equivalent object key orders and does not mutate the request", () => {
    const first = request({
      tools: [{ name: "lookup", parameters: { type: "object", properties: { query: { type: "string" }, city: { type: "string" } } } }],
    })
    const reordered = request({
      tools: [{ parameters: { properties: { city: { type: "string" }, query: { type: "string" } }, type: "object" }, name: "lookup" }],
    })
    const before = JSON.stringify(first)
    expect(known(estimateModelRequestAdmission(first, profile)).estimatedInputTokens)
      .toBe(known(estimateModelRequestAdmission(reordered, profile)).estimatedInputTokens)
    expect(JSON.stringify(first)).toBe(before)
  })

  it("matches normal JSON omission of optional undefined object properties", () => {
    const withUndefined = known(estimateModelRequestAdmission(request({ outputSchema: { type: "object", description: undefined } }), profile))
    const omitted = known(estimateModelRequestAdmission(request({ outputSchema: { type: "object" } }), profile))
    expect(withUndefined.estimatedInputTokens).toBe(omitted.estimatedInputTokens)
  })

  it("estimates the complete request built from real registry-advertised tools", () => {
    const tool: RuntimeToolDefinition = {
      schemaVersion: "agent-harness.v2", name: "jobs.search", version: "1",
      description: "Search jobs", capabilities: ["read"], domain: "jobs",
      inputSchema: Type.Object({ query: Type.String() }, { additionalProperties: false }),
      outputSchema: Type.Object({ count: Type.Integer() }, { additionalProperties: false }),
      risk: "read", idempotency: "read_only", timeoutMs: 100, requiredCapabilities: [],
      execute: async () => ({ count: 1 }),
    }
    const context: StepContext = {
      schemaVersion: "agent-harness.v2", sessionId: "session", turnId: "turn", stepId: "step",
      inputThroughSequence: 0n, consumedInputIds: [], canonicalJson: "{}",
      blocks: [{ id: "goal", layer: "goal", role: "data", trust: "external_untrusted", source: "turn_goal", content: "Find jobs" }],
    }
    const model = { profile } as ModelAdapter
    const built = buildModelRequest({
      context, model, tools: new ToolRegistry([tool]).list(),
      sessionId: "session", turnId: "turn", stepId: "step", userId: "user", taskId: "task",
      signal: new AbortController().signal,
    })

    expect(built.tools[0]).not.toHaveProperty("execute")
    expect(estimateModelRequestAdmission(built, profile)).toMatchObject({ status: "known" })
  })

  it("uses the inclusive estimated input-plus-output boundary", () => {
    const input = request({ maxOutputTokens: 20 })
    const initial = known(estimateModelRequestAdmission(input, profile))
    const exactWindow = initial.estimatedInputTokens + initial.outputReserveTokens
    const boundaryProfile = { ...profile, defaultMaxOutputTokens: 8 }
    expect(known(estimateModelRequestAdmission(input, { ...boundaryProfile, maxContextTokens: exactWindow })).withinWindow).toBe(true)
    expect(known(estimateModelRequestAdmission(input, { ...boundaryProfile, maxContextTokens: exactWindow - 1 })).withinWindow).toBe(false)
  })

  it("uses an explicit output cap and never substitutes the capability maximum for an unknown default", () => {
    expect(known(estimateModelRequestAdmission(request({ maxOutputTokens: 24 }), profile)).outputReserveTokens).toBe(24)
    const noDefault = estimateModelRequestAdmission(request(), { ...profile, defaultMaxOutputTokens: null })
    expect(noDefault).toMatchObject({ status: "unknown", reason: "output_reserve_unknown" })
  })

  it.each([
    [{ ...profile, maxContextTokens: null }, request(), "context_window_unknown"],
    [{ ...profile, defaultMaxOutputTokens: undefined }, request(), "output_reserve_unknown"],
    [profile, request({ continuation: { providerResponseId: "opaque-response" } }), "continuation_state_unmeasurable"],
    [profile, request({ messages: [{ role: "user", content: [{ type: "attachment_ref", attachmentId: "attachment-1", mediaType: "image/png" }] }] }), "non_text_content"],
  ] as const)("keeps unknown capacity or unmeasurable request state compatible", (candidateProfile, candidateRequest, reason) => {
    expect(estimateModelRequestAdmission(candidateRequest, candidateProfile)).toMatchObject({ status: "unknown", reason })
  })

  it("returns unknown rather than inventing a size for circular or otherwise unserializable schemas", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(estimateModelRequestAdmission(request({ outputSchema: circular }), profile)).toMatchObject({
      status: "unknown", reason: "unserializable_request",
    })
  })

  it("does not execute getters in the request and keeps their size unknown", () => {
    let getterCalled = false
    const schema = Object.defineProperty({ type: "object" }, "description", {
      enumerable: true,
      get() { getterCalled = true; return "schema" },
    })
    expect(estimateModelRequestAdmission(request({ outputSchema: schema }), profile)).toMatchObject({
      status: "unknown", reason: "unserializable_request",
    })
    expect(getterCalled).toBe(false)
  })

  it("keeps invalid profile metadata and explicit caps as ordinary typed errors", () => {
    expect(() => estimateModelRequestAdmission(request(), { ...profile, maxContextTokens: 0 })).toThrow(
      expect.objectContaining({ code: "configuration_error" }),
    )
    expect(() => estimateModelRequestAdmission(request({ maxOutputTokens: 0 }), profile)).toThrow(
      expect.objectContaining({ code: "invalid_request" }),
    )
    expect(() => estimateModelRequestAdmission(request({ maxOutputTokens: 5_000 }), profile)).toThrow(
      expect.objectContaining({ code: "invalid_request" }),
    )
    expect(() => estimateModelRequestAdmission(request(), { ...profile, defaultMaxOutputTokens: 0 })).toThrow(
      expect.objectContaining({ code: "configuration_error" }),
    )
    expect(() => estimateModelRequestAdmission(request(), { ...profile, defaultMaxOutputTokens: 5_000 })).toThrow(
      expect.objectContaining({ code: "configuration_error" }),
    )
    expect(() => estimateModelRequestAdmission(request(), { ...profile, maxContextTokens: 64, defaultMaxOutputTokens: 128 })).toThrow(
      expect.objectContaining({ code: "configuration_error" }),
    )
  })

  it("exposes an explicitly classified local rejection with actionable approximate guidance", () => {
    const error = new ContextEstimateExceededError({
      provider: "anthropic", model: "claude-test", guaranteedNoProviderAttempt: false,
    })
    expect(error).toBeInstanceOf(AgentModelError)
    expect(error).toMatchObject({
      code: "context_estimate_exceeded", provider: "anthropic", model: "claude-test",
      retryable: false, recoverable: false, guaranteedNoProviderAttempt: false,
    })
    expect(error.message).toContain("Approximate")
    expect(error.message).toContain("larger-context route")
    expect(error.message).toContain("required content was not removed")
  })
})
