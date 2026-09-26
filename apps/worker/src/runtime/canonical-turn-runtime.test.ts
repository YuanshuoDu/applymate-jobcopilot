import { describe, expect, it, vi } from "vitest"

vi.mock("ioredis", () => ({ Redis: vi.fn().mockImplementation(() => ({ disconnect: vi.fn() })) }))

import type { HarnessModelRequest, ModelAdapter, ModelStreamEvent } from "@jobcopilot/agent-model"
import type pg from "pg"
import type { StepContext } from "./context/step-context-builder.js"
import type { CanonicalTurnState } from "./canonical-turn-state.js"
import type { TurnEngineEvent, TurnEngineStore } from "./turns/turn-engine-types.js"
import { createCanonicalTurnRuntime } from "./canonical-turn-runtime.js"
import { loadCanonicalTurnState } from "./canonical-turn-state.js"
import { TurnEngine } from "./turns/turn-engine.js"
import { createPgRootTaskStore } from "./subagents/root-task-store.js"
import { reclaimExpiredTurns } from "./turns/recovery-scanner.js"
import { runTurnJob } from "./turns/turn-queue.js"
import type { TurnLease } from "./turns/lease.js"
import { resolveProductionAgentFlags, type ProductionAgentFlags } from "./production-agent-flags.js"

const lease = {
  turnId: "turn-1", sessionId: "session-1", ownerId: "worker-1", userId: "user-1", leaseVersion: 2,
  leaseStartedAt: new Date("2026-09-07T00:00:00.000Z"), leaseExpiresAt: new Date("2026-09-07T00:01:00.000Z"),
}
const recoveredPlanHash = `sha256:${"a".repeat(64)}`
type RuntimeEvent = { id?: string; type: string; payload: unknown; correlationId?: string; idempotencyKey?: string; owner?: unknown }

function state(): CanonicalTurnState {
  return { scope: { userId: "user-1" }, goal: "Find jobs", modelProfileSnapshot: { provider: "fixture", model: "fixture" }, toolPolicySnapshot: {}, budgetSnapshot: { limits: { maxSteps: 4 } }, snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] } }
}

function store(events: RuntimeEvent[] = [], batches: RuntimeEvent[][] = [], itemUpdates: unknown[] = []): TurnEngineStore {
  return {
    startStep: async ({ stepId, ordinal }) => ({ id: stepId, ordinal }), updateStep: async () => undefined,
    createItem: async ({ itemId }) => ({ id: itemId, revision: 0 }), updateItem: async input => { itemUpdates.push(input); return { id: input.itemId, revision: input.expectedRevision + 1 } },
    appendEvent: async ({ id, type, payload, correlationId, idempotencyKey, owner }) => { events.push({ id, type, payload, correlationId, idempotencyKey, owner }); return { id } },
    recordFinalResponse: async input => {
      const terminal = input.terminal
      if (!terminal) return
      const saved: TurnEngineEvent[] = [
        { id: "final-started", type: "item.started", itemId: terminal.finalItemId, correlationId: terminal.stepId, causationId: null, payload: { itemId: terminal.finalItemId, type: "agent_message", phase: "final_answer" } },
        { id: "final-completed", type: "item.completed", itemId: terminal.finalItemId, correlationId: terminal.finalItemId, causationId: "final-started", payload: { itemId: terminal.finalItemId, status: "completed", content: terminal.finalContent } },
        { id: "turn-completed", type: "turn.completed", itemId: terminal.finalItemId, correlationId: terminal.stepId, causationId: "final-completed", payload: { turnId: input.owner.turnId, taskId: input.owner.taskId, finalItemId: terminal.finalItemId, usage: terminal.usage } },
      ]
      events.push(...saved.map(event => ({ ...event, owner: input.owner, idempotencyKey: event.id })))
      return { status: "completed", finalItemId: terminal.finalItemId, events: saved }
    },
    appendEvents: async inputs => { const batch = inputs.map(input => ({ id: input.id, type: input.type, payload: input.payload, correlationId: input.correlationId, idempotencyKey: input.idempotencyKey, owner: input.owner })); batches.push(batch); events.push(...batch); return inputs.map(input => ({ id: input.id })) },
  }
}

function contextBuilder() {
  return {
    build: async (request: { sessionId: string; turnId: string; stepId: string; snapshot: CanonicalTurnState["snapshot"] }): Promise<StepContext> => ({
      schemaVersion: "agent-harness.v2", sessionId: request.sessionId, turnId: request.turnId, stepId: request.stepId, inputThroughSequence: 0n, consumedInputIds: [],
      blocks: request.snapshot.toolObservations.map(item => ({ id: item.id, layer: "tool_observation", role: "data", trust: "external_untrusted", source: "tool_or_subagent", content: item.content as never })), canonicalJson: "{}",
    }),
  }
}

function model(script: () => ModelStreamEvent[]): ModelAdapter {
  return { id: "fixture", profile: { provider: "fixture", model: "fixture", nativeTools: true, structuredOutput: true, streaming: true, continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false, supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false, supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: null, costClass: "low" }, async *stream() { yield* script() } }
}

function rootStore() {
  return { ensure: vi.fn(async () => ({ id: "root-1" } as never)), checkCompletion: vi.fn(async () => ({ ok: true as const })), finish: vi.fn(async () => undefined) }
}

function waitBoundary() {
  let turnStatus = "in_progress"
  let rootTaskId: string | null = null
  let taskStatus = "queued"
  let taskLeaseOwner: string | null = "old-worker"
  let taskLeaseExpiresAt: Date | null = new Date("2026-09-06T23:59:00.000Z")
  const calls: string[] = []
  const taskRow = () => ({
    id: rootTaskId ?? "root-turn-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: rootTaskId ?? "root-turn-1", parentTaskId: null,
    path: "/root-turn-1", depth: 0, role: "orchestrator", taskType: "root", status: taskStatus, goal: "Find jobs", constraints: [], successCriteria: [], allowedActions: ["jobs.search"],
    context: {}, expectedOutputSchema: {}, result: null, failureReason: null, attemptCount: 1, maxAttempts: 1, leaseOwner: taskLeaseOwner, leaseExpiresAt: taskLeaseExpiresAt,
    interruptRequestedAt: null, budgetSnapshot: {}, toolPolicySnapshot: {},
  })
  const client = {
    query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push(sql)
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM "agent_turns"') && sql.includes('"rootTaskId"')) return { rows: [{ rootTaskId }], rowCount: 1 }
      if (sql.includes('INSERT INTO "sub_agent_tasks"')) { rootTaskId = String(values?.[0]); taskStatus = "running"; taskLeaseOwner = String(values?.[9]); return { rows: [], rowCount: 1 } }
      if (sql.includes('UPDATE "agent_turns"')) { rootTaskId = String(values?.[0]); return { rows: [], rowCount: 1 } }
      if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [taskRow()], rowCount: 1 }
      if (sql.includes('SELECT "id" FROM "agent_turns"')) {
        const acceptsWait = sql.includes('"status" IN (\'in_progress\', \'waiting_for_user\')')
        return { rows: turnStatus === "in_progress" || (turnStatus === "waiting_for_user" && acceptsWait) ? [{ id: "turn-1" }] : [], rowCount: turnStatus === "in_progress" || (turnStatus === "waiting_for_user" && acceptsWait) ? 1 : 0 }
      }
      if (sql.includes('UPDATE "sub_agent_tasks"')) { taskStatus = String(values?.[0]); taskLeaseOwner = null; taskLeaseExpiresAt = null; return { rows: [], rowCount: 1 } }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client), query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }
  return { pool: pool as unknown as pg.Pool, calls, setWaiting: () => { turnStatus = "waiting_for_user" }, getState: () => ({ turnStatus, taskStatus, taskLeaseOwner, taskLeaseExpiresAt }) }
}

function realPgBoundary() {
  const calls: string[] = []
  const client = {
    query: vi.fn(async (sql: string) => {
      calls.push(sql)
      if (sql.includes("WITH candidates")) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
      if (sql.includes('FROM "agent_steps"')) return { rows: [{ inputThroughSequence: 0n, consumedInputIds: [] }], rowCount: 1 }
      if (sql.includes('FROM "agent_inputs"')) return { rows: [], rowCount: 0 }
      if (sql.includes('JOIN "agent_sessions"')) return { rows: [{ id: "turn-1" }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  const jobs = [{ id: "job-1", company: "Example", role: "Engineer", location: "Dublin", status: "open", score: 8, url: "https://jobs.example/1", source: "fixture", salary: null, description: "Role contact candidate@example.test with key sk-secretvalue123", keywords: null, createdAt: new Date("2026-09-07T00:00:00.000Z"), updatedAt: new Date("2026-09-07T00:00:00.000Z") }]
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async (sql: string) => sql.includes('FROM "Job"') ? { rows: jobs, rowCount: 1 } : { rows: [], rowCount: 0 }),
  }
  return { pool: pool as unknown as pg.Pool, calls, client }
}

function defaultLoaderBoundary() {
  const calls: string[] = []
  const client = {
    query: vi.fn(async (sql: string) => {
      calls.push(sql)
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 0 }
      if (sql.includes('"input"') && sql.includes('FROM "agent_turns"')) return {
        rows: [{ id: "turn-1", sessionId: "session-1", userId: "user-1", status: "in_progress", leaseOwnerId: lease.ownerId, leaseVersion: lease.leaseVersion, leaseExpiresAt: lease.leaseExpiresAt, input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: { limits: { maxSteps: 4 } } }], rowCount: 1,
      }
      if (sql.includes('FROM "agent_wait_conditions"')) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM "agent_steps"') || sql.includes('FROM "agent_items"') || sql.includes('FROM "agent_events"') || sql.includes('FROM "agent_inputs"') || sql.includes('FROM "agent_context_snapshots"')) return { rows: [], rowCount: 0 }
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn(async () => client) } as unknown as pg.Pool, calls }
}

const CANONICAL_COORDINATION_TOOL_NAMES = [
  "agent.spawn", "agent.send", "agent.followup", "agent.wait", "agent.list", "agent.interrupt", "agent.close",
] as const

function coordinationDefinitions(missing: readonly string[] = []): readonly { name: string; version: string }[] {
  return CANONICAL_COORDINATION_TOOL_NAMES
    .filter(name => !missing.includes(name))
    .map(name => ({ name, version: "1" }))
}

function tools(includeCoordination = false, missing: readonly string[] = []) {
  const execute = vi.fn(async (context: { taskId?: string; rootTaskId?: string }, call: { id: string; toolName: string; toolVersion: string }) => ({ ...call, status: "completed" as const, output: { ok: true }, errorCode: null, taskId: context.taskId, rootTaskId: context.rootTaskId }))
  return {
    execute,
    registry: { list: () => [{ name: "jobs.search", version: "1" }, ...(includeCoordination ? coordinationDefinitions(missing) : [])], resolve: () => ({ idempotency: "read_only" as const }), validateArguments: () => true as const },
    router: { execute },
  }
}

function waitingTools() {
  const execute = vi.fn(async (_context: unknown, call: { id: string; toolName: string; toolVersion: string }) => ({ ...call, status: "failed" as const, output: null, errorCode: "policy_requires_user_input" }))
  return { execute, registry: { list: () => [{ name: "jobs.search", version: "1" }], validateArguments: () => true as const }, router: { execute } }
}

function setup(overrides: Record<string, unknown> = {}) {
  const roots = rootStore()
  const tool = tools(overrides.coordinationEnabled === true)
  let calls = 0
  const runtime = createCanonicalTurnRuntime({ connect: vi.fn() } as never, {
    workerId: "worker-1", stateLoader: async () => state(), rootTaskStore: roots as never,
    modelRuntimeFactory: async () => ({ adapter: model(() => { calls += 1; return calls === 1 ? [{ type: "tool_call_completed", callId: "call-1", name: "jobs.search", arguments: { location: "Dublin" } }, { type: "completed", finishReason: "tool_calls" }] : [{ type: "text_delta", text: "done" }, { type: "completed", finishReason: "stop" }] }), registry: {} as never, candidates: [] }),
    toolRuntimeFactory: () => tool as never, turnEngineStoreFactory: () => store(), contextBuilderFactory: () => contextBuilder(),
    authorizeUsage: async () => ({ settle: vi.fn(async () => undefined) }), ...overrides,
  })
  return { runtime, roots, tool, getModelCalls: () => calls }
}

async function rootToolNames(coordinationEnabled: boolean, capabilities = ["read"], productionFlags?: ProductionAgentFlags): Promise<string[]> {
  const requests: HarnessModelRequest[] = []
  const runtime = await createCanonicalTurnRuntime({ connect: vi.fn() } as never, {
    workerId: "worker-1", coordinationEnabled, ...(productionFlags ? { productionFlags } : {}), stateLoader: async () => ({ ...state(), toolPolicySnapshot: { capabilities } }),
    rootTaskStore: rootStore() as never, turnEngineStoreFactory: () => store(), contextBuilderFactory: () => contextBuilder(),
    modelRuntimeFactory: async () => ({ adapter: {
      ...model(() => []),
      async *stream(request: HarnessModelRequest) {
        requests.push(request)
        yield { type: "text_delta", text: "done" }
        yield { type: "completed", finishReason: "stop" }
      },
    }, registry: {} as never, candidates: [] }),
    authorizeUsage: async () => ({ settle: async () => undefined }),
  })
  await runtime.execute({ lease, signal: new AbortController().signal })
  return requests[0]?.tools.flatMap(tool => {
    if (!tool || typeof tool !== "object" || !("name" in tool) || typeof tool.name !== "string") return []
    return [tool.name]
  }) ?? []
}

describe("createCanonicalTurnRuntime", () => {
  it("replays a persisted read-only call before the first resumed model request", async () => {
    const recoveredCall = { call: { id: "crash-call", name: "jobs.search", arguments: { location: "Dublin" } }, toolVersion: "1", stepId: "step-0", callItem: { id: "persisted-call-item", revision: 0 } }
    const tool = tools()
    tool.execute.mockImplementationOnce(async (context, call) => ({ ...call, status: "completed", output: { ok: true, jobs: ["recovered"] }, errorCode: null, taskId: context.taskId, rootTaskId: context.rootTaskId }))
    const events: RuntimeEvent[] = [], itemUpdates: unknown[] = [], requests: HarnessModelRequest[] = [], roots = rootStore()
    let modelCalls = 0
    const runtime = await createCanonicalTurnRuntime({ connect: vi.fn() } as never, {
      workerId: "worker-1", stateLoader: async () => ({ ...state(), pendingToolCalls: [recoveredCall], resume: { nextOrdinal: 1, stepCount: 1, toolCallCount: 1, inputThroughSequence: 0n, consumedInputIds: [], usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } } }),
      rootTaskStore: roots as never, turnEngineStoreFactory: () => store(events, [], itemUpdates), contextBuilderFactory: () => contextBuilder(),
      modelRuntimeFactory: async () => ({ adapter: {
        ...model(() => []),
        async *stream(request: HarnessModelRequest) { requests.push(request); modelCalls += 1; yield { type: "text_delta", text: "done" }; yield { type: "completed", finishReason: "stop" } },
      }, registry: {} as never, candidates: [] }),
      toolRuntimeFactory: () => tool as never, authorizeUsage: async () => ({ settle: async () => undefined }),
    })

    await expect(runtime.execute({ lease, signal: new AbortController().signal })).resolves.toMatchObject({ status: "completed" })
    expect(tool.execute).toHaveBeenCalledTimes(1)
    expect(tool.execute).toHaveBeenCalledWith(expect.objectContaining({ stepId: "step-0" }), expect.objectContaining({ id: "crash-call", toolName: "jobs.search", input: { location: "Dublin" } }))
    expect(modelCalls).toBe(1)
    expect(JSON.stringify(requests[0]?.messages)).toContain("recovered")
    expect(events.some(event => event.type === "tool_call.completed" && JSON.stringify(event.payload).includes("crash-call"))).toBe(true)
    expect(itemUpdates[0]).toEqual(expect.objectContaining({ itemId: "persisted-call-item", owner: expect.objectContaining({ ownerId: lease.ownerId, leaseVersion: lease.leaseVersion }) }))
  })

  it("terminally reconciles an ambiguous non-repeatable call without executing or queuing it again", async () => {
    const recoveredCall = { call: { id: "ambiguous-call", name: "apply.submit", arguments: { jobId: "job-1" } }, toolVersion: "1", stepId: "step-0", callItem: { id: "persisted-call-item", revision: 0 } }
    const tool = tools(), events: RuntimeEvent[] = [], roots = rootStore()
    const executeTool = vi.fn(tool.execute)
    let modelCalls = 0
    const runtime = await createCanonicalTurnRuntime({ connect: vi.fn() } as never, {
      workerId: "worker-1", stateLoader: async () => ({ ...state(), pendingToolCalls: [recoveredCall], resume: { nextOrdinal: 1, stepCount: 1, toolCallCount: 1, inputThroughSequence: 0n, consumedInputIds: [], usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } } }),
      rootTaskStore: roots as never, turnEngineStoreFactory: () => store(events),
      modelRuntimeFactory: async () => ({ adapter: { ...model(() => []), async *stream() { modelCalls += 1; yield { type: "text_delta", text: "must not run" }; yield { type: "completed", finishReason: "stop" } } }, registry: {} as never, candidates: [] }),
      toolRuntimeFactory: () => ({ registry: { ...tool.registry, resolve: () => ({ idempotency: "non_repeatable" }) }, router: { execute: executeTool } }) as never,
      authorizeUsage: async () => ({ settle: async () => undefined }),
    })

    await expect(runtime.execute({ lease, signal: new AbortController().signal })).resolves.toMatchObject({ status: "failed", summary: "tool_result_replay_uncertain" })
    expect(executeTool).not.toHaveBeenCalled()
    expect(modelCalls).toBe(0)
    expect(events.some(event => event.type === "tool_call.failed" && JSON.stringify(event.payload).includes("tool_result_replay_uncertain"))).toBe(true)
    expect(events.some(event => event.type === "turn.failed" && JSON.stringify(event.payload).includes("tool_result_replay_uncertain"))).toBe(true)
    expect(roots.finish).toHaveBeenCalledTimes(1)
  })

  it("fails closed on a resume fence drift before constructing the provider runtime", async () => {
    const modelRuntimeFactory = vi.fn(async () => ({ adapter: model(() => []), registry: {} as never, candidates: [] }))
    const runtime = await setup({ stateLoader: async () => { throw new Error("cognitive_agenda_resume_fence_invalid") }, modelRuntimeFactory }).runtime
    await expect(runtime.execute({ lease, signal: new AbortController().signal })).rejects.toThrow("cognitive_agenda_resume_fence_invalid")
    expect(modelRuntimeFactory).not.toHaveBeenCalled()
  })

  it("exposes the resolved child and coordination gates for production bootstrap", async () => {
    const runtime = await setup({ productionFlags: resolveProductionAgentFlags({ ENABLE_AGENT_CHILD_EXECUTION: "1", ENABLE_AGENT_WAIT_RESOLVER: "1" }) }).runtime

    expect(runtime.childExecutionEnabled).toBe(true)
    expect(runtime.coordinationEnabled).toBe(true)
  })

  it("rejects an inconsistent server activation contract", async () => {
    const productionFlags = {
      ...resolveProductionAgentFlags(),
      childExecutionEnabled: false,
      coordinationEnabled: true,
    }

    await expect(createCanonicalTurnRuntime({ connect: vi.fn() } as never, {
      workerId: "worker-1", productionFlags,
    })).rejects.toThrow("coordination_requires_child_execution")
  })

  it("does not require coordination tools while the coordination gate is disabled", async () => {
    const fixture = setup({ coordinationEnabled: false, toolRuntimeFactory: () => tools() as never })
    await expect((await fixture.runtime).execute({ lease, signal: new AbortController().signal })).resolves.toMatchObject({ status: "completed" })
    expect(fixture.getModelCalls()).toBeGreaterThan(0)
  })

  it("accepts a custom registry with the complete canonical coordination surface", async () => {
    const fixture = setup({ coordinationEnabled: true, toolRuntimeFactory: () => tools(true) as never })
    await expect((await fixture.runtime).execute({ lease, signal: new AbortController().signal })).resolves.toMatchObject({ status: "completed" })
  })

  it("fails closed before model invocation when a canonical coordination tool is missing", async () => {
    const fixture = setup({
      coordinationEnabled: true,
      toolRuntimeFactory: () => tools(true, ["agent.close"]) as never,
    })
    await expect((await fixture.runtime).execute({ lease, signal: new AbortController().signal })).rejects.toThrow("canonical_coordination_tools_unconfigured")
    expect(fixture.getModelCalls()).toBe(0)
  })

  it("derives root coordination capability from the production gate", async () => {
    const disabled = await rootToolNames(false)
    expect(disabled).not.toEqual(expect.arrayContaining(["spawn_subagent", "wait_subagents", "list_subagents", "send_message", "interrupt_subagent", "close_subagent"]))
    const enabled = await rootToolNames(true)
    expect(enabled).toEqual(expect.arrayContaining(["spawn_subagent", "wait_subagents", "list_subagents", "send_message", "interrupt_subagent", "close_subagent"]))
  })

  it("settles the root after the real wait transition and releases its task lease", async () => {
    const boundary = waitBoundary()
    const tool = waitingTools()
    const runtime = await createCanonicalTurnRuntime(boundary.pool, {
      workerId: "worker-1", stateLoader: async () => state(), rootTaskStore: createPgRootTaskStore(boundary.pool),
      modelRuntimeFactory: async () => ({ adapter: model(() => [{ type: "tool_call_completed", callId: "wait-call", name: "jobs.search", arguments: { location: "Dublin" } }, { type: "completed", finishReason: "tool_calls" }]), registry: {} as never, candidates: [] }),
      toolRuntimeFactory: () => tool as never,
      turnEngineStoreFactory: () => ({ ...store(), waitForUser: async () => boundary.setWaiting() }),
      contextBuilderFactory: () => contextBuilder(), authorizeUsage: async () => ({ settle: async () => undefined }),
    })

    await expect(runtime.execute({ lease, signal: new AbortController().signal })).resolves.toMatchObject({ status: "waiting_for_user", summary: "policy_requires_user_input" })
    expect(boundary.getState()).toMatchObject({ turnStatus: "waiting_for_user", taskStatus: "waiting_for_user", taskLeaseOwner: null, taskLeaseExpiresAt: null })
    expect(boundary.calls.some(sql => sql.includes('"status" IN (\'in_progress\', \'waiting_for_user\')'))).toBe(true)
  })

  it("preserves a dependency waitId for the durable queue handoff", async () => {
    const engineRun = vi.spyOn(TurnEngine.prototype, "run").mockResolvedValue({
      status: "waiting_for_dependency", stepCount: 1, toolCallCount: 0, waitId: "wait-1",
    })
    try {
      const fixture = setup()
      await expect((await fixture.runtime).execute({ lease, signal: new AbortController().signal })).resolves.toMatchObject({
        status: "waiting_for_dependency", waitId: "wait-1",
      })
      expect(fixture.roots.finish).toHaveBeenCalledWith(expect.objectContaining({
        result: expect.objectContaining({ status: "waiting_for_dependency", waitId: "wait-1" }),
      }))
    } finally {
      engineRun.mockRestore()
    }
  })

  it("routes production wait-outcome consumption through the default state loader", async () => {
    const run = async (productionFlags: ProductionAgentFlags) => {
      const boundary = defaultLoaderBoundary()
      const runtime = await createCanonicalTurnRuntime(boundary.pool, {
        workerId: "worker-1", productionFlags, rootTaskStore: rootStore() as never,
        modelRuntimeFactory: async () => ({ adapter: model(() => [{ type: "text_delta", text: "done" }, { type: "completed", finishReason: "stop" }]), registry: {} as never, candidates: [] }),
        toolRuntimeFactory: () => tools(productionFlags.coordinationEnabled) as never,
        turnEngineStoreFactory: () => store(), contextBuilderFactory: () => contextBuilder(),
        now: () => new Date("2026-09-07T00:00:00.000Z"),
        authorizeUsage: async () => ({ settle: async () => undefined }),
      })
      await runtime.execute({ lease, signal: new AbortController().signal })
      return boundary.calls
    }
    const enabledCalls = await run(resolveProductionAgentFlags({ ENABLE_AGENT_CHILD_EXECUTION: "1", ENABLE_AGENT_WAIT_RESOLVER: "1" }))
    expect(enabledCalls.some(sql => sql.includes('FROM "agent_wait_conditions"'))).toBe(true)
    const disabledCalls = await run(resolveProductionAgentFlags())
    expect(disabledCalls.some(sql => sql.includes('FROM "agent_wait_conditions"'))).toBe(false)
  })

  it("composes a real model/tool continuation with runtime-owned root identity", async () => {
    const fixture = setup()
    const runtime = await fixture.runtime
    await expect(runtime.execute({ lease, signal: new AbortController().signal })).resolves.toMatchObject({ status: "completed" })
    expect(fixture.getModelCalls()).toBe(2)
    expect(fixture.tool.execute).toHaveBeenCalledWith(expect.objectContaining({ taskId: "root-1", rootTaskId: "root-1" }), expect.objectContaining({ toolName: "jobs.search" }))
    expect(fixture.roots.finish).toHaveBeenCalledWith(expect.objectContaining({ rootTaskId: "root-1", result: expect.objectContaining({ status: "completed" }) }))
  })

  it("projects automation control state around canonical execution and fails closed on projection errors", async () => {
    const projection = { start: vi.fn(async () => undefined), finish: vi.fn(async () => undefined) }
    const fixture = setup({ executionProjection: projection })
    const runtime = await fixture.runtime

    await expect(runtime.execute({ lease, signal: new AbortController().signal })).resolves.toMatchObject({ status: "completed" })
    expect(projection.start).toHaveBeenCalledWith({ userId: "user-1", sessionId: "session-1", turnId: "turn-1" })
    expect(projection.finish).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1", sessionId: "session-1", turnId: "turn-1", result: expect.objectContaining({ status: "completed" }) }))
    expect(fixture.roots.finish.mock.invocationCallOrder[0]).toBeLessThan(projection.finish.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER)

    const failedProjection = { start: vi.fn(async () => { throw new Error("control projection unavailable") }), finish: vi.fn(async () => undefined) }
    const failed = setup({ executionProjection: failedProjection })
    const failedRuntime = await failed.runtime
    await expect(failedRuntime.execute({ lease, signal: new AbortController().signal })).rejects.toThrow("control projection unavailable")
    expect(failed.getModelCalls()).toBe(0)
    expect(failed.roots.finish).not.toHaveBeenCalled()

    const failedFinishProjection = { start: vi.fn(async () => undefined), finish: vi.fn(async () => { throw new Error("control result projection unavailable") }) }
    const failedFinish = setup({ executionProjection: failedFinishProjection })
    const failedFinishRuntime = await failedFinish.runtime
    await expect(failedFinishRuntime.execute({ lease, signal: new AbortController().signal })).rejects.toThrow("control result projection unavailable")
    expect(failedFinish.roots.finish).toHaveBeenCalledTimes(1)
  })

  it("projects the automation session lifecycle with the leased Turn identity", async () => {
    const executionProjection = { start: vi.fn(async () => undefined), finish: vi.fn(async () => undefined) }
    const sessionProjection = { start: vi.fn(async () => undefined), finish: vi.fn(async () => undefined) }
    const fixture = setup({ executionProjection, sessionProjection })
    const runtime = await fixture.runtime

    await expect(runtime.execute({ lease, signal: new AbortController().signal })).resolves.toMatchObject({ status: "completed" })
    expect(sessionProjection.start).toHaveBeenCalledWith({ userId: "user-1", sessionId: "session-1", turnId: "turn-1" })
    expect(sessionProjection.finish).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1", sessionId: "session-1", turnId: "turn-1", result: expect.objectContaining({ status: "completed" }) }))
    expect(fixture.roots.finish.mock.invocationCallOrder[0]).toBeLessThan(executionProjection.finish.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER)
    expect(executionProjection.finish.mock.invocationCallOrder[0]).toBeLessThan(sessionProjection.finish.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER)
  })

  it.each(["waiting_for_dependency", "waiting_for_approval", "waiting_for_user"] as const)("rebinds a %s root after its wake instead of treating it as terminal", async status => {
    const result = { status, summary: "needs_resume", ...(status === "waiting_for_dependency" ? { waitId: "wait-1" } : {}) }
    const roots = { ...rootStore(), reconcileTerminal: vi.fn().mockResolvedValue({ rootTaskId: "root-1", result }) }
    const sessionProjection = { start: vi.fn(async () => undefined), finish: vi.fn(async () => undefined) }
    const fixture = setup({ rootTaskStore: roots, sessionProjection })
    const runtime = await fixture.runtime

    await expect(runtime.execute({ lease, signal: new AbortController().signal })).resolves.toMatchObject({ status: "completed" })
    expect(roots.ensure).toHaveBeenCalledTimes(1)
    expect(fixture.getModelCalls()).toBe(2)
    expect(sessionProjection.start).toHaveBeenCalledOnce()
    expect(sessionProjection.finish).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", result: expect.objectContaining({ status: "completed" }),
    }))
  })

  it("reconciles a terminal root on projection retry without rerunning the engine", async () => {
    const roots = { ...rootStore(), reconcileTerminal: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ rootTaskId: "root-1", result: { status: "failed" as const, summary: "provider_error" } }) }
    const projection = { start: vi.fn(async () => undefined), finish: vi.fn().mockRejectedValueOnce(new Error("projection unavailable")).mockResolvedValueOnce(undefined) }
    const fixture = setup({ rootTaskStore: roots, executionProjection: projection })
    const runtime = await fixture.runtime

    await expect(runtime.execute({ lease, signal: new AbortController().signal })).rejects.toThrow("projection unavailable")
    await expect(runtime.execute({ lease, signal: new AbortController().signal })).resolves.toEqual({ status: "failed", summary: "provider_error" })
    expect(roots.reconcileTerminal).toHaveBeenCalledTimes(2)
    expect(projection.start).toHaveBeenCalledTimes(1)
    expect(fixture.getModelCalls()).toBe(2)
    expect(roots.finish).toHaveBeenCalledTimes(1)
    expect(projection.finish).toHaveBeenCalledTimes(2)
    expect(projection.finish).toHaveBeenLastCalledWith(expect.objectContaining({ userId: "user-1", sessionId: "session-1", turnId: "turn-1", result: { status: "failed", errorCode: "provider_error" } }))
  })

  it("passes the server-owned completion gate for the canonical root", async () => {
    const fixture = setup()
    await fixture.runtime.then(runtime => runtime.execute({ lease, signal: new AbortController().signal }))
    expect(fixture.roots.checkCompletion).toHaveBeenCalledWith(expect.objectContaining({ rootTaskId: "root-1", lease }))
  })

  it("fails closed before provider invocation when usage authorization is unavailable", async () => {
    const fixture = setup({ authorizeUsage: undefined })
    const runtime = await fixture.runtime
    await expect(runtime.execute({ lease, signal: new AbortController().signal })).resolves.toMatchObject({ status: "failed", summary: "usage_authorization_unavailable" })
    expect(fixture.getModelCalls()).toBe(0)
    expect(fixture.tool.execute).not.toHaveBeenCalled()
  })

  it("settles model usage once and records stable provider error codes", async () => {
    const settlement = vi.fn(async (input: { status: "success" | "error"; errorCode?: string }) => {
      if (input.status === "success") throw new Error("ledger implementation detail")
    })
    const fixture = setup({
      authorizeUsage: async () => ({ settle: settlement }),
      modelRuntimeFactory: async () => ({
        adapter: {
          ...model(() => []),
          async *stream() {
            const error = Object.assign(new Error("provider response body must stay private"), { code: "provider_error" })
            throw error
          },
        }, registry: {} as never, candidates: [],
      }),
    })
    const runtime = await fixture.runtime
    await expect(runtime.execute({ lease, signal: new AbortController().signal })).resolves.toMatchObject({ status: "failed" })
    expect(settlement).toHaveBeenCalledTimes(1)
    expect(settlement).toHaveBeenCalledWith(expect.objectContaining({ status: "error", errorCode: "provider_error" }))

    const successSettlement = vi.fn(async (input: { status: "success" | "error" }) => {
      if (input.status === "success") throw new Error("settlement failed")
    })
    const successFixture = setup({
      authorizeUsage: async () => ({ settle: successSettlement }),
      modelRuntimeFactory: async () => ({ adapter: model(() => [{ type: "text_delta", text: "done" }, { type: "completed", finishReason: "stop" }]), registry: {} as never, candidates: [] }),
    })
    const successRuntime = await successFixture.runtime
    await expect(successRuntime.execute({ lease, signal: new AbortController().signal })).resolves.toMatchObject({ status: "failed" })
    expect(successSettlement).toHaveBeenCalledTimes(1)
    expect(successSettlement).toHaveBeenCalledWith(expect.objectContaining({ status: "success" }))
  })

  it("runs the canonical factory with the real registry, router, and context builder", async () => {
    const pg = realPgBoundary()
    const roots = rootStore()
    const requests: HarnessModelRequest[] = []
    const events: Array<{ type: string; payload: unknown }> = []
    let modelCalls = 0
    const modelRuntime = await createCanonicalTurnRuntime(pg.pool, {
      workerId: "worker-1", stateLoader: async () => ({ ...state(), rootInputId: "input-1" }), rootTaskStore: roots as never,
      modelRuntimeFactory: async () => ({
        adapter: {
          ...model(() => []),
          async *stream(request) {
            requests.push(request)
            modelCalls += 1
            if (modelCalls === 1) {
              yield { type: "tool_call_completed", callId: "real-call", name: "jobs.search", arguments: { location: "Dublin" } }
              yield { type: "completed", finishReason: "tool_calls" }
            } else {
              yield { type: "text_delta", text: "Observed Example" }
              yield { type: "completed", finishReason: "stop" }
            }
          },
        }, registry: {} as never, candidates: [],
      }),
      turnEngineStoreFactory: () => store(events), authorizeUsage: async () => ({ settle: async () => undefined }),
    })
    const result = await modelRuntime.execute({ lease, signal: new AbortController().signal })
    expect(result).toMatchObject({ status: "completed" })
    expect(modelCalls).toBe(2)
    expect(requests[1]?.messages.some(message => JSON.stringify(message).includes("job-1"))).toBe(true)
    expect(JSON.stringify(requests[1]?.messages)).not.toContain("candidate@example.test")
    expect(JSON.stringify(requests[1]?.messages)).not.toContain("sk-secretvalue123")
    expect(events.some(event => event.type === "tool_call.completed" && JSON.stringify(event.payload).includes("job-1"))).toBe(true)
    expect(JSON.stringify(events)).not.toContain("candidate@example.test")
    expect(JSON.stringify(events)).not.toContain("sk-secretvalue123")
    expect(pg.pool.query).toHaveBeenCalledWith(expect.stringContaining('FROM "Job"'), expect.any(Array))
    expect(pg.calls.some(sql => sql === "BEGIN")).toBe(true)
  })


})
