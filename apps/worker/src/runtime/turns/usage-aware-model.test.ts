import { describe, expect, it, vi } from "vitest"
import type { HarnessModelRequest, ModelAdapter, ModelStreamEvent } from "@jobcopilot/agent-model"
import { createHarnessModelRuntime, type HarnessFetch } from "../harness-model.js"

import { createUsageAwareModelAdapter } from "./usage-aware-model.js"
import { ContextEstimateExceededError } from "./model-request-admission.js"
import type { WorkerUsageSettlementInput } from "../../queue/ai-usage-bridge.js"
import type { ExecutionOwnerFence } from "../execution-owner.js"
import type { TreeBudgetReservation, TreeBudgetReservationStore } from "../subagents/tree-budget-types.js"

const profile = {
  provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true, continuationCursor: false,
  supportsParallelTools: false, supportsStreamingToolArgs: true, supportsReasoningSummary: true, supportsResponseContinuation: false,
  supportsProviderConversation: false, supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: null, costClass: "low" as const,
}
const owner: ExecutionOwnerFence = {
  kind: "task", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "child-1", rootTaskId: "root-1", ownerId: "worker-1",
  attemptCount: 2, leaseExpiresAt: new Date("2026-09-09T12:00:00.000Z"),
}
const request: HarnessModelRequest = {
  schemaVersion: "agent-harness.v2", provider: profile.provider, model: profile.model, messages: [], tools: [],
  capabilities: { nativeTools: true, structuredOutput: true, streaming: true, continuationCursor: false }, signal: new AbortController().signal,
  metadata: { sessionId: owner.sessionId, turnId: owner.turnId, stepId: "step-1", taskId: owner.taskId, userId: owner.userId },
}

function reservation(status: TreeBudgetReservation["status"] = "reserved"): TreeBudgetReservation {
  const now = new Date("2026-09-09T00:00:00.000Z")
  return { id: "reservation-1", userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
  taskId: owner.taskId, stepId: "step-1", attempt: 2, units: 1, status, idempotencyKey: "key-1", createdAt: now, updatedAt: now, settledAt: null }
}

function store(behavior: (status: "consumed" | "released") => Promise<void> = async () => undefined): { store: TreeBudgetReservationStore; statuses: string[] } {
  const statuses: string[] = []
  return {
    statuses,
    store: {
      reserve: vi.fn(async () => reservation()),
      settle: vi.fn(async input => { statuses.push(input.status); await behavior(input.status) ; return reservation(input.status) }),
    },
  }
}

function adapter(events: readonly ModelStreamEvent[] = [{ type: "usage", inputTokens: 2, outputTokens: 3 }, { type: "completed", finishReason: "stop" }]): ModelAdapter {
  return { id: "fixture", profile, async *stream(_input) { yield* events } }
}

function rejectingAdapter(error: unknown): ModelAdapter {
  return { id: "fixture-rejecting", profile, async *stream() { throw error } }
}

function setRouteContextWindow(runtime: ReturnType<typeof createHarnessModelRuntime>, provider: string, maxContextTokens: number): void {
  const route = runtime.registry.list().find(item => item.profile.provider === provider)
  if (!route) throw new Error(`fixture route missing: ${provider}`)
  runtime.registry.unregister(route.id)
  runtime.registry.register({ ...route, profile: { ...route.profile, maxContextTokens, defaultMaxOutputTokens: 64 } })
}

function oversizedRequest(): HarnessModelRequest {
  return { ...request, maxOutputTokens: 64, messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(9000) }] }] }
}

function harnessRuntime(fetcher: HarnessFetch, contexts: readonly [number, number?], onRequestAdmission?: () => void) {
  const runtime = createHarnessModelRuntime({
    primary: { provider: "minimax", model: "MiniMax-M3", apiKey: "minimax-key" },
    ...(contexts[1] === undefined ? {} : { fallbacks: [{ provider: "anthropic", model: "claude-sonnet-5", apiKey: "anthropic-key" }] }),
    allowEnvironmentFallbacks: false, fetch: fetcher, onRequestAdmission,
  })
  setRouteContextWindow(runtime, "minimax", contexts[0])
  if (contexts[1] !== undefined) setRouteContextWindow(runtime, "anthropic", contexts[1])
  return runtime
}

function spreadPrivateOutputAdapter(adapter: ModelAdapter): ModelAdapter {
  return { ...adapter, async *stream(input) { yield* adapter.stream({ ...input }) } }
}

describe("usage-aware model owner seam", () => {
  it("sends a child owner envelope and consumes one shared tree step", async () => {
    const fixture = store()
    const authorize = vi.fn(async () => ({ settle: vi.fn(async () => undefined) }))
    const events: ModelStreamEvent[] = []
    for await (const event of createUsageAwareModelAdapter(adapter(), { owner, authorize, treeBudget: fixture.store }).stream(request)) events.push(event)
    expect(events).toHaveLength(2)
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      executionOwner: { kind: "task", taskId: "child-1", rootTaskId: "root-1", ownerId: "worker-1", attemptCount: 2 },
      attemptId: "child-1:2",
    }))
    expect(fixture.statuses).toEqual(["consumed"])
  })

  it("releases a tree reservation when account admission is denied", async () => {
    const fixture = store()
    const model = createUsageAwareModelAdapter(adapter(), { owner, treeBudget: fixture.store, authorize: vi.fn(async () => { throw new Error("usage_denied") }) })
    await expect((async () => { for await (const _event of model.stream(request)) return undefined })()).rejects.toThrow("usage_denied")
    expect(fixture.statuses).toEqual(["released"])
  })

  it("keeps the reservation active when tree settlement itself fails", async () => {
    const fixture = store(async status => { if (status === "consumed") throw new Error("tree_store_unavailable") })
    const model = createUsageAwareModelAdapter(adapter(), { owner, treeBudget: fixture.store, authorize: vi.fn(async () => ({ settle: vi.fn(async () => undefined) })) })
    await expect((async () => { for await (const _event of model.stream(request)) return undefined })()).rejects.toThrow("tree_store_unavailable")
    expect(fixture.statuses).toEqual(["consumed"])
  })

  it("keeps the reservation active when account settlement is unknown", async () => {
    const fixture = store()
    const model = createUsageAwareModelAdapter(adapter(), {
      owner, treeBudget: fixture.store,
      authorize: vi.fn(async () => ({ settle: vi.fn(async () => { throw new Error("account_settlement_unknown") }) })),
    })
    await expect((async () => { for await (const _event of model.stream(request)) return undefined })()).rejects.toThrow("account_settlement_unknown")
    expect(fixture.statuses).toEqual([])
  })

  it("releases a child reservation after a known zero-usage local context rejection", async () => {
    const fixture = store(), settlements: unknown[] = []
    const settle = vi.fn(async (value: WorkerUsageSettlementInput) => { settlements.push(value) })
    const model = createUsageAwareModelAdapter(rejectingAdapter(new ContextEstimateExceededError({
      provider: profile.provider, model: profile.model, guaranteedNoProviderAttempt: true,
    })), { owner, treeBudget: fixture.store, authorize: vi.fn(async () => ({ settle })) })
    await expect((async () => { for await (const _event of model.stream(request)) return undefined })())
      .rejects.toMatchObject({ code: "context_estimate_exceeded", guaranteedNoProviderAttempt: true })
    expect(settlements).toEqual([{ status: "error", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0,
      errorCode: "context_estimate_exceeded" }])
    expect(fixture.statuses).toEqual(["released"])
  })

  it("consumes the reservation when a local rejection follows an earlier route attempt", async () => {
    const fixture = store()
    const model = createUsageAwareModelAdapter(rejectingAdapter(new ContextEstimateExceededError({
      provider: profile.provider, model: profile.model, guaranteedNoProviderAttempt: false,
    })), { owner, treeBudget: fixture.store, authorize: vi.fn(async () => ({ settle: vi.fn(async () => undefined) })) })
    await expect((async () => { for await (const _event of model.stream(request)) return undefined })())
      .rejects.toMatchObject({ code: "context_estimate_exceeded", guaranteedNoProviderAttempt: false })
    expect(fixture.statuses).toEqual(["consumed"])
  })

  it("keeps a local rejection reservation active when zero-usage settlement is unknown", async () => {
    const fixture = store()
    const model = createUsageAwareModelAdapter(rejectingAdapter(new ContextEstimateExceededError({
      provider: profile.provider, model: profile.model, guaranteedNoProviderAttempt: true,
    })), { owner, treeBudget: fixture.store,
      authorize: vi.fn(async () => ({ settle: vi.fn(async () => { throw new Error("account settlement unknown") }) })) })
    await expect((async () => { for await (const _event of model.stream(request)) return undefined })())
      .rejects.toMatchObject({ code: "context_estimate_exceeded", guaranteedNoProviderAttempt: true })
    expect(fixture.statuses).toEqual([])
  })

  it("releases the child reservation without authorizing or settling when every Harness route fails preflight through a spread wrapper", async () => {
    const fixture = store(), settlement = vi.fn(), authorize = vi.fn(async () => ({ settle: settlement }))
    const fetcher = vi.fn(async () => { throw new Error("preflight reached fetch") })
    const runtime = harnessRuntime(fetcher, [500, 500])
    const model = createUsageAwareModelAdapter(spreadPrivateOutputAdapter(runtime.adapter), { owner, authorize, treeBudget: fixture.store })

    await expect((async () => { for await (const _event of model.stream(oversizedRequest())) return undefined })())
      .rejects.toMatchObject({ code: "context_estimate_exceeded", guaranteedNoProviderAttempt: true })
    expect(authorize).not.toHaveBeenCalled()
    expect(settlement).not.toHaveBeenCalled()
    expect(fixture.statuses).toEqual(["released"])
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("authorizes the fitting fallback after its preflight and settles only that route through a spread wrapper", async () => {
    const order: string[] = [], fixture = store()
    const fetcher: HarnessFetch = vi.fn(async url => {
      order.push("fetch")
      expect(url).toContain("anthropic")
      return new Response([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}',
        'event: message_stop\ndata: {"type":"message_stop"}',
      ].join("\n\n"), { headers: { "Content-Type": "text/event-stream" } })
    })
    const runtime = harnessRuntime(fetcher, [500, 5000], () => { order.push("preflight") })
    const settlement = vi.fn(async () => undefined)
    const authorize = vi.fn(async input => { order.push(`authorize:${input.provider}`); return { settle: settlement, release: vi.fn() } })
    const model = createUsageAwareModelAdapter(spreadPrivateOutputAdapter(runtime.adapter), { owner, authorize, treeBudget: fixture.store })

    const events: ModelStreamEvent[] = []
    for await (const event of model.stream(oversizedRequest())) events.push(event)
    expect(events.some(event => event.type === "text_delta" && event.text === "ok")).toBe(true)
    expect(order).toEqual(["preflight", "preflight", "authorize:anthropic", "fetch"])
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(settlement).toHaveBeenCalledOnce()
    expect(fixture.statuses).toEqual(["consumed"])
  })

  it("authorizes and settles each provider fallback independently, without refund after provider start", async () => {
    const fixture = store(), settled = new Map<string, ReturnType<typeof vi.fn>>(), released = new Map<string, ReturnType<typeof vi.fn>>()
    const fetcher = vi.fn(async () => new Response("provider unavailable", { status: 503 }))
    const runtime = harnessRuntime(fetcher, [5000, 5000])
    const authorize = vi.fn(async input => {
      const settle = vi.fn(async () => undefined), release = vi.fn(async () => undefined)
      settled.set(input.provider, settle); released.set(input.provider, release)
      return { settle, release }
    })
    const model = createUsageAwareModelAdapter(runtime.adapter, { owner, authorize, treeBudget: fixture.store })

    await expect((async () => { for await (const _event of model.stream(request)) return undefined })()).rejects.toMatchObject({ code: "provider_error" })
    expect(authorize.mock.calls.map(([input]) => `${input.provider}/${input.model}`)).toEqual([
      "minimax/MiniMax-M3", "anthropic/claude-sonnet-5",
    ])
    expect(settled.get("minimax")).toHaveBeenCalledWith(expect.objectContaining({ status: "error", errorCode: "provider_rerouted" }))
    expect(settled.get("anthropic")).toHaveBeenCalledWith(expect.objectContaining({ status: "error" }))
    expect([...released.values()].every(release => !release.mock.calls.length)).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fixture.statuses).toEqual(["consumed"])
  })

  it("releases account and child credit once when async authorization resolves after cancellation", async () => {
    const controller = new AbortController(), fixture = store()
    let beginAuthorization!: () => void, finishAuthorization!: (value: { settle: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }) => void
    const authorizationStarted = new Promise<void>(resolve => { beginAuthorization = resolve })
    const authorization = new Promise<{ settle: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }>(resolve => { finishAuthorization = resolve })
    const settle = vi.fn(), release = vi.fn(async () => undefined), fetcher = vi.fn(async () => { throw new Error("cancelled request reached provider") })
    const runtime = harnessRuntime(fetcher, [5000])
    const model = createUsageAwareModelAdapter(runtime.adapter, {
      owner, treeBudget: fixture.store, authorize: vi.fn(() => { beginAuthorization(); return authorization }),
    })
    const pending = (async () => { for await (const _event of model.stream({ ...request, signal: controller.signal })) return undefined })()
    await authorizationStarted
    controller.abort(new Error("cancelled during authorization"))
    finishAuthorization({ settle, release })

    await expect(pending).rejects.toThrow("cancelled during authorization")
    expect(fetcher).not.toHaveBeenCalled()
    expect(settle).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
    expect(fixture.statuses).toEqual(["released"])
  })

  it("does not admit or fetch when cancellation precedes route authorization", async () => {
    const controller = new AbortController(), fixture = store()
    controller.abort(new Error("already cancelled"))
    const fetcher = vi.fn(async () => { throw new Error("cancelled request reached provider") })
    const authorize = vi.fn(async () => ({ settle: vi.fn(), release: vi.fn() }))
    const model = createUsageAwareModelAdapter(harnessRuntime(fetcher, [5000]).adapter, { owner, treeBudget: fixture.store, authorize })

    await expect((async () => { for await (const _event of model.stream({ ...request, signal: controller.signal })) return undefined })())
      .rejects.toThrow("already cancelled")
    expect(authorize).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
    expect(fixture.statuses).toEqual(["released"])
  })

  it("does not fetch or try a fallback when deferred authorization is denied", async () => {
    const diagnostics: string[] = [], fetcher = vi.fn(async () => { throw new Error("authorization reached fetch") })
    const runtime = harnessRuntime(fetcher, [5000, 5000], () => { diagnostics.push("preflight") })
    const authorize = vi.fn(async () => { throw new Error("usage_denied") })
    const model = createUsageAwareModelAdapter(runtime.adapter, { owner, authorize })

    await expect((async () => { for await (const _event of model.stream(request)) return undefined })()).rejects.toMatchObject({ message: "usage_denied" })
    expect(authorize).toHaveBeenCalledOnce()
    expect(diagnostics).toEqual(["preflight"])
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("keeps eager authorization for ordinary non-Harness adapters", async () => {
    const order: string[] = []
    const ordinary = adapter([{ type: "completed", finishReason: "stop" }])
    const wrapped = createUsageAwareModelAdapter({
      ...ordinary, async *stream() { order.push("provider"); yield { type: "completed", finishReason: "stop" } },
    }, { owner, authorize: vi.fn(async () => { order.push("authorize"); return { settle: vi.fn(async () => undefined) } }) })

    for await (const _event of wrapped.stream(request)) undefined
    expect(order).toEqual(["authorize", "provider"])
  })
})
