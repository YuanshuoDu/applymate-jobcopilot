import { describe, expect, it, vi } from "vitest"
import type { ModelAdapter, ModelStreamEvent } from "@jobcopilot/agent-model"

import type { StepContext, StepContextSnapshot } from "../context/step-context-builder.js"
import { TurnLeaseError } from "./lease.js"
import { createToolRouterExecutor, TurnEngine } from "./turn-engine.js"
import { toRepositoryJson, type TurnEngineOptions, type TurnEngineStore } from "./turn-engine-types.js"

const lease = {
  turnId: "turn-1", sessionId: "session-1", ownerId: "owner-1", userId: "user-1", leaseVersion: 4,
  leaseStartedAt: new Date("2026-09-01T00:00:00.000Z"), leaseExpiresAt: new Date("2026-09-01T00:10:00.000Z"),
}
const now = new Date("2026-09-01T00:01:00.000Z")

function profile() {
  return {
    provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true, continuationCursor: false,
    supportsParallelTools: false, supportsStreamingToolArgs: true, supportsReasoningSummary: true,
    supportsResponseContinuation: false, supportsProviderConversation: false, supportsBackgroundResponse: false,
    maxContextTokens: null, maxOutputTokens: null, costClass: "low" as const,
  }
}

function fakeStore() {
  const events: Array<{ id: string; type: string; causationId: string | null; itemId: string | null }> = []
  const items: Array<{ id: string; type: string; phase: string | null; status: string; revision: number }> = []
  const steps: Array<{ id: string; status: string; errorCode: string | null }> = []
  const value: TurnEngineStore = {
    startStep: async ({ stepId }) => { steps.push({ id: stepId, status: "streaming", errorCode: null }); return { id: stepId } },
    updateStep: async ({ stepId, status, errorCode }) => { const step = steps.find((entry) => entry.id === stepId)!; step.status = status; step.errorCode = errorCode },
    createItem: async ({ itemId, type, phase, status }) => { items.push({ id: itemId, type, phase, status, revision: 0 }); return { id: itemId, revision: 0 } },
    updateItem: async ({ itemId, expectedRevision, status }) => { const item = items.find((entry) => entry.id === itemId)!; expect(item.revision).toBe(expectedRevision); item.revision += 1; item.status = status; return { id: itemId, revision: item.revision } },
    appendEvent: async ({ id, type, causationId, itemId }) => { events.push({ id, type, causationId, itemId }); return { id } },
    recordFinalResponse: vi.fn(async () => undefined),
  }
  return { value, events, items, steps }
}

function contextBuilder(seen: StepContextSnapshot[]) {
  return {
    build: async (request: Parameters<NonNullable<TurnEngineOptions["contextBuilder"]["build"]>>[0]): Promise<StepContext> => {
      seen.push(request.snapshot)
      const blocks: StepContext["blocks"] = [
        { id: "system", layer: "system", role: "instruction", trust: "system", source: "harness", content: { rule: "safe" } },
        { id: "goal", layer: "goal", role: "data", trust: "external_untrusted", source: "turn_goal", content: "Find jobs" },
        ...request.snapshot.toolObservations.map((observation) => ({ id: observation.id, layer: "tool_observation" as const, role: "data" as const, trust: "external_untrusted" as const, source: "tool_or_subagent", content: toRepositoryJson(observation.content) })),
      ]
      return { schemaVersion: "agent-harness.v2", sessionId: request.sessionId, turnId: request.turnId, stepId: request.stepId, inputThroughSequence: BigInt(seen.length), consumedInputIds: seen.length === 1 ? ["steer-1"] : ["steer-1"], blocks, canonicalJson: JSON.stringify(blocks) }
    },
  }
}

function baseOptions(overrides: Partial<TurnEngineOptions> = {}) {
  const fake = fakeStore()
  const snapshots: StepContextSnapshot[] = []
  let modelCall = 0
  const requests: Array<{ messages: readonly { role: string; content: readonly unknown[] }[] }> = []
  const model: ModelAdapter = {
    id: "fixture-model",
    profile: profile(),
    async *stream(request) {
      modelCall += 1
      requests.push(request as unknown as { messages: readonly { role: string; content: readonly unknown[] }[] })
      const scripted: ModelStreamEvent[] = modelCall === 1
        ? [{ type: "reasoning_summary_delta", text: "Search" }, { type: "text_delta", text: "Searching jobs" }, { type: "tool_call_completed", callId: "call-1", name: "jobs.search", arguments: { location: "Dublin" } }, { type: "completed", finishReason: "tool_calls" }]
        : modelCall === 2
          ? [{ type: "text_delta", text: "Inspecting a result" }, { type: "tool_call_completed", callId: "call-2", name: "jobs.get", arguments: { jobId: "job-1" } }, { type: "completed", finishReason: "tool_calls" }]
          : [{ type: "text_delta", text: "The role is a strong match." }, { type: "completed", finishReason: "stop" }]
      for (const event of scripted) yield event
    },
  }
  const options: TurnEngineOptions = {
    lease, scope: { userId: "user-1" }, goal: "Find jobs", snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] },
    contextBuilder: contextBuilder(snapshots), store: fake.value, model, tools: [{ name: "jobs.search", version: "1" }, { name: "jobs.get", version: "1" }],
    executeTool: async ({ call }) => ({ id: call.id, toolName: call.toolName, toolVersion: call.toolVersion, status: "completed" as const, output: call.toolName === "jobs.search" ? { jobs: [{ id: "job-1" }] } : { job: { id: "job-1", role: "Engineer" } }, errorCode: null }),
    now: () => now, maxSteps: 5,
    idFactory: (() => { let id = 0; return (prefix: string) => `${prefix}:${++id}` })(),
    ...overrides,
  }
  return { options, fake, snapshots, requests }
}

describe("TurnEngine", () => {
  it("runs a durable 3-step loop, feeds tool results into context, and emits one final", async () => {
    const fixture = baseOptions()
    const result = await new TurnEngine(fixture.options).run()
    expect(result).toMatchObject({ status: "completed", stepCount: 3, toolCallCount: 2 })
    expect(fixture.fake.steps.map((step) => step.status)).toEqual(["completed", "completed", "completed"])
    expect(fixture.fake.events.filter((event) => event.type === "turn.completed")).toHaveLength(1)
    expect(fixture.fake.items.filter((item) => item.type === "agent_message" && item.phase === "final_answer")).toHaveLength(1)
    expect(fixture.requests[1].messages.flatMap((message) => message.content).some((part) => JSON.stringify(part).includes("jobs.search"))).toBe(true)
    expect(fixture.requests[2].messages.flatMap((message) => message.content).some((part) => JSON.stringify(part).includes("jobs.get"))).toBe(true)
    expect(fixture.fake.events.slice(1).every((event, index) => event.causationId === fixture.fake.events[index].id)).toBe(true)
  })

  it("continues when the client subscriber disconnects", async () => {
    const fixture = baseOptions({ subscribe: async () => { throw new Error("SSE disconnected") } })
    await expect(new TurnEngine(fixture.options).run()).resolves.toMatchObject({ status: "completed" })
    expect(fixture.fake.events.some((event) => event.type === "turn.completed")).toBe(true)
  })

  it("stops with a typed lease error before starting another tool", async () => {
    const controller = new AbortController()
    const fixture = baseOptions({ signal: controller.signal, executeTool: async ({ call }) => { controller.abort(); return { id: call.id, toolName: call.toolName, toolVersion: "1", status: "completed" as const, output: {}, errorCode: null } } })
    await expect(new TurnEngine(fixture.options).run()).rejects.toBeInstanceOf(TurnLeaseError)
    expect(fixture.fake.events.some((event) => event.type === "turn.completed")).toBe(false)
  })

  it("fails closed when a stop response has no verifiable final", async () => {
    const fixture = baseOptions({ maxSteps: 1, model: { id: "empty", profile: profile(), async *stream() { yield { type: "completed", finishReason: "stop" } } } })
    await expect(new TurnEngine(fixture.options).run()).resolves.toMatchObject({ status: "failed", errorCode: "final_unverified" })
    expect(fixture.fake.events.filter((event) => event.type === "turn.completed")).toHaveLength(0)
  })

  it("binds ToolRouter execution to the runtime-owned tenant and actor", async () => {
    const execute = vi.fn(async (context, call) => ({ ...call, status: "completed" as const, output: { ok: true }, errorCode: null, actorRole: context.actorRole }))
    const router = { execute }
    const executor = createToolRouterExecutor(router)
    await expect(executor({ scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: "step-1", signal: new AbortController().signal, call: { id: "call-1", toolName: "jobs.get", toolVersion: "1", input: { jobId: "job-1" } } })).resolves.toMatchObject({ status: "completed", actorRole: "orchestrator" })
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ scope: { userId: "user-1" }, actorRole: "orchestrator" }), expect.objectContaining({ id: "call-1" }))
  })
})
