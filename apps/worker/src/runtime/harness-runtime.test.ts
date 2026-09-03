import { describe, expect, it, vi } from "vitest"

import { createHarnessModelRuntime, type HarnessFetch } from "./harness-model.js"
import { assertReadOnlyHarnessTools, createHarnessTurnExecutor } from "./harness-runtime.js"
import { createToolRouterExecutor } from "./turns/turn-engine.js"
import { toRepositoryJson, type TurnEngineOptions, type TurnEngineStore } from "./turns/turn-engine-types.js"
import type { StepContext } from "./context/step-context-builder.js"

const lease = {
  turnId: "turn-1", sessionId: "session-1", ownerId: "owner-1", userId: "user-1", leaseVersion: 1,
  leaseStartedAt: new Date("2026-09-01T00:00:00.000Z"), leaseExpiresAt: new Date("2026-09-01T00:10:00.000Z"),
}

function response(lines: readonly string[]): Response {
  return new Response(lines.join("\n\n"), { headers: { "Content-Type": "text/event-stream" } })
}

function storeFixture(): { store: TurnEngineStore; events: Array<{ type: string; payload: unknown }>; items: Array<{ id: string; type: string; content: unknown; revision: number }> } {
  const events: Array<{ type: string; payload: unknown }> = []
  const items: Array<{ id: string; type: string; content: unknown; revision: number }> = []
  const steps = new Set<string>()
  const store: TurnEngineStore = {
    startStep: async ({ stepId }) => { steps.add(stepId); return { id: stepId } },
    updateStep: async ({ stepId }) => { expect(steps.has(stepId)).toBe(true) },
    createItem: async ({ itemId, type, content }) => { const item = { id: itemId, type, content, revision: 0 }; items.push(item); return item },
    updateItem: async ({ itemId, expectedRevision, content, status }) => {
      const item = items.find((candidate) => candidate.id === itemId)
      expect(item?.revision).toBe(expectedRevision)
      item!.revision += 1
      item!.content = content
      return { id: itemId, revision: item!.revision }
    },
    appendEvent: async ({ id, type, payload }) => { events.push({ type, payload }); return { id } },
    recordFinalResponse: vi.fn(async () => undefined),
  }
  return { store, events, items }
}

function tool() {
  return {
    schemaVersion: "agent-harness.v2" as const,
    name: "jobs.search",
    version: "1",
    description: "Search the candidate job shortlist",
    capabilities: ["read"] as const,
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: { type: "object" },
    risk: "read" as const,
    domain: "jobs" as const,
    idempotency: "read_only" as const,
    timeoutMs: 10_000,
    requiredCapabilities: [] as const,
  }
}

function contextBuilder(): TurnEngineOptions["contextBuilder"] {
  return {
    build: async ({ sessionId, turnId, stepId, snapshot }): Promise<StepContext> => ({
      schemaVersion: "agent-harness.v2",
      sessionId,
      turnId,
      stepId,
      inputThroughSequence: 0n,
      consumedInputIds: [],
      blocks: [
        { id: "system", layer: "system", role: "instruction", trust: "system", source: "harness", content: { readOnly: true } },
        { id: "goal", layer: "goal", role: "data", trust: "external_untrusted", source: "turn_goal", content: "Find Dublin jobs" },
        ...snapshot.toolObservations.map((observation) => ({ id: observation.id, layer: "tool_observation" as const, role: "data" as const, trust: "external_untrusted" as const, source: "tool_or_subagent", content: toRepositoryJson(observation.content) })),
      ],
      canonicalJson: JSON.stringify(snapshot),
    }),
  }
}

describe("MiniMax Harness runtime integration", () => {
  it("completes model-tool-model-final with correlated native messages and private reasoning suppressed", async () => {
    const bodies: Array<Record<string, unknown>> = []
    let call = 0
    const fetcher: HarnessFetch = vi.fn(async (_url, init) => {
      call += 1
      const body = JSON.parse(init.body) as Record<string, unknown>
      bodies.push(body)
      if (call === 1) return response([
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "jobs.search", arguments: '{"query":"Dublin"}' } }] }, finish_reason: "tool_calls" }] })}`,
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } })}`,
        "data: [DONE]",
      ])
      expect(body.messages).toEqual(expect.arrayContaining([
        { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "jobs.search", arguments: '{"query":"Dublin"}' } }] },
        { role: "tool", tool_call_id: "call-1", content: '{"jobs":[{"id":"job-1"}]}' },
      ]))
      return response([
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_details: [{ text: "PRIVATE_REASONING" }], content: "Found one suitable role." }, finish_reason: "stop" }] })}`,
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 18, completion_tokens: 6 } })}`,
        "data: [DONE]",
      ])
    })
    const runtime = createHarnessModelRuntime({
      primary: { provider: "minimax", model: "MiniMax-M3", apiKey: "minimax-key" },
      fetch: fetcher,
    })
    const fixture = storeFixture()
    const router = {
      execute: vi.fn(async (context: { capabilities?: readonly string[] }, request: { id: string; toolName: string; toolVersion: string }) => ({
        ...request, status: "completed" as const, output: { jobs: [{ id: "job-1" }] }, errorCode: null, capabilities: context.capabilities,
      })),
    }
    const execute = createToolRouterExecutor(router)
    const executor = createHarnessTurnExecutor({
      scope: { userId: "user-1" },
      goal: "Find Dublin jobs",
      snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] },
      contextBuilder: contextBuilder(), store: fixture.store, tools: [tool()], executeTool: execute,
      capabilities: ["read"], modelRuntime: runtime, maxSteps: 3,
      idFactory: (() => { let id = 0; return (prefix: string) => `${prefix}:${++id}` })(),
    })
    const result = await executor({ lease, signal: new AbortController().signal })
    expect(result).toMatchObject({ status: "completed", stepCount: 2, toolCallCount: 1 })
    expect(bodies).toHaveLength(2)
    expect(router.execute).toHaveBeenCalledWith(expect.objectContaining({ capabilities: ["read"] }), expect.objectContaining({ id: "call-1" }))
    expect(fixture.items.some((item) => item.type === "reasoning_summary")).toBe(false)
    expect(JSON.stringify(fixture.items)).not.toContain("PRIVATE_REASONING")
    expect(fixture.events.filter((event) => event.type === "model.usage")).toHaveLength(2)
    expect(fixture.events.filter((event) => event.type === "model.usage").map((event) => (event.payload as Record<string, unknown>).provider)).toEqual(["minimax", "minimax"])
    expect(JSON.stringify(fixture.events.filter((event) => event.type === "model.usage"))).not.toContain("PRIVATE_REASONING")
  })

  it("rejects a write-capable tool set at the Harness boundary", () => {
    expect(() => assertReadOnlyHarnessTools([{ ...tool(), risk: "external_write", idempotency: "non_repeatable", capabilities: ["external_write"] }])).toThrow(/non-read-only/)
  })

  it("allows only the typed approval-bound Gmail write tools", () => {
    expect(() => assertReadOnlyHarnessTools([
      { ...tool(), name: "gmail.create_draft", domain: "gmail", risk: "internal_write", idempotency: "requires_key", capabilities: ["read", "write"] },
      { ...tool(), name: "gmail.send", domain: "gmail", risk: "external_write", idempotency: "non_repeatable", capabilities: ["read", "write", "external_write"] },
    ])).not.toThrow()
    expect(() => assertReadOnlyHarnessTools([{ ...tool(), name: "gmail.send", domain: "gmail", risk: "external_write", idempotency: "requires_key", capabilities: ["read", "write", "external_write"] }])).toThrow(/non-read-only/)
  })

  it("allows only the typed provenance-bound artifact draft tools", () => {
    expect(() => assertReadOnlyHarnessTools([
      { ...tool(), name: "resume.draft", domain: "resume", risk: "draft_write", idempotency: "requires_key", capabilities: ["read", "write"] },
      { ...tool(), name: "cover_letter.draft", domain: "resume", risk: "draft_write", idempotency: "requires_key", capabilities: ["read", "write"] },
    ])).not.toThrow()
    expect(() => assertReadOnlyHarnessTools([{ ...tool(), name: "resume.draft", domain: "resume", risk: "internal_write", idempotency: "requires_key", capabilities: ["read", "write"] }])).toThrow(/non-read-only/)
    expect(() => assertReadOnlyHarnessTools([{ ...tool(), name: "resume.draft", domain: "resume", risk: "draft_write", idempotency: "requires_key", capabilities: ["read"] }])).toThrow(/non-read-only/)
  })
})
