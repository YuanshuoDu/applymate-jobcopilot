import { describe, expect, it, vi } from "vitest"
import type { HarnessModelRequest, ModelAdapter, ModelStreamEvent } from "@jobcopilot/agent-model"
import type pg from "pg"
import type { StepContext } from "./context/step-context-builder.js"
import type { CanonicalTurnState } from "./canonical-turn-state.js"
import type { TurnEngineStore } from "./turns/turn-engine-types.js"
import { createCanonicalTurnRuntime } from "./canonical-turn-runtime.js"
import { createPgRootTaskStore } from "./subagents/root-task-store.js"
import type { PlanProposal } from "./planning/goal-plan-contract.js"
import { PLAN_MAX_REVISIONS } from "./planning/goal-plan-contract.js"
import { fingerprintPlanProposal } from "./planning/plan-fingerprint.js"

const lease = {
  turnId: "turn-1", sessionId: "session-1", ownerId: "worker-1", userId: "user-1", leaseVersion: 2,
  leaseStartedAt: new Date("2026-09-07T00:00:00.000Z"), leaseExpiresAt: new Date("2026-09-07T00:01:00.000Z"),
}
const recoveredPlanHash = `sha256:${"a".repeat(64)}`

function state(): CanonicalTurnState {
  return { scope: { userId: "user-1" }, goal: "Find jobs", modelProfileSnapshot: { provider: "fixture", model: "fixture" }, toolPolicySnapshot: {}, budgetSnapshot: { limits: { maxSteps: 4 } }, snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] } }
}

function store(events: Array<{ type: string; payload: unknown; correlationId?: string; idempotencyKey?: string; owner?: unknown }> = []): TurnEngineStore {
  return {
    startStep: async ({ stepId, ordinal }) => ({ id: stepId, ordinal }), updateStep: async () => undefined,
    createItem: async ({ itemId }) => ({ id: itemId, revision: 0 }), updateItem: async ({ itemId, expectedRevision }) => ({ id: itemId, revision: expectedRevision + 1 }),
    appendEvent: async ({ id, type, payload, correlationId, idempotencyKey, owner }) => { events.push({ type, payload, correlationId, idempotencyKey, owner }); return { id } }, recordFinalResponse: async () => undefined,
    appendEvents: async inputs => { events.push(...inputs.map(input => ({ type: input.type, payload: input.payload, correlationId: input.correlationId, idempotencyKey: input.idempotencyKey, owner: input.owner }))); return inputs.map(input => ({ id: input.id })) },
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
  return { ensure: vi.fn(async () => ({ id: "root-1" } as never)), finish: vi.fn(async () => undefined) }
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

function tools() {
  const execute = vi.fn(async (context: { taskId?: string; rootTaskId?: string }, call: { id: string; toolName: string; toolVersion: string }) => ({ ...call, status: "completed" as const, output: { ok: true }, errorCode: null, taskId: context.taskId, rootTaskId: context.rootTaskId }))
  return {
    execute,
    registry: { list: () => [{ name: "jobs.search", version: "1" }], validateArguments: () => true as const },
    router: { execute },
  }
}

function waitingTools() {
  const execute = vi.fn(async (_context: unknown, call: { id: string; toolName: string; toolVersion: string }) => ({ ...call, status: "failed" as const, output: null, errorCode: "policy_requires_user_input" }))
  return { execute, registry: { list: () => [{ name: "jobs.search", version: "1" }], validateArguments: () => true as const }, router: { execute } }
}

function setup(overrides: Record<string, unknown> = {}) {
  const roots = rootStore()
  const tool = tools()
  let calls = 0
  const runtime = createCanonicalTurnRuntime({ connect: vi.fn() } as never, {
    workerId: "worker-1", stateLoader: async () => state(), rootTaskStore: roots as never,
    modelRuntimeFactory: async () => ({ adapter: model(() => { calls += 1; return calls === 1 ? [{ type: "tool_call_completed", callId: "call-1", name: "jobs.search", arguments: { location: "Dublin" } }, { type: "completed", finishReason: "tool_calls" }] : [{ type: "text_delta", text: "done" }, { type: "completed", finishReason: "stop" }] }), registry: {} as never, candidates: [] }),
    toolRuntimeFactory: () => tool as never, turnEngineStoreFactory: () => store(), contextBuilderFactory: () => contextBuilder(),
    authorizeUsage: async () => ({ settle: vi.fn(async () => undefined) }), ...overrides,
  })
  return { runtime, roots, tool, getModelCalls: () => calls }
}

async function rootToolNames(coordinationEnabled: boolean, planningEnabled = false, capabilities = ["read"]): Promise<string[]> {
  const requests: HarnessModelRequest[] = []
  const runtime = await createCanonicalTurnRuntime({ connect: vi.fn() } as never, {
    workerId: "worker-1", coordinationEnabled, planningEnabled, stateLoader: async () => ({ ...state(), toolPolicySnapshot: { capabilities } }),
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

async function runDefaultPlanBridge(planningExecutionEnabled: boolean) {
  const roots = rootStore()
  const calls: string[] = []
  const events: Array<{ type: string; payload: unknown; correlationId?: string; idempotencyKey?: string; owner?: unknown }> = []
  let modelCalls = 0
  const proposal: PlanProposal = {
    schemaVersion: "agent-harness.plan.v1", basedOnGoalRevision: 1, basedOnPlanRevision: null,
    nodes: [{ localId: "read", kind: "use_tool", objective: "Read jobs", inputRefs: [], dependsOn: [], successCriteria: ["done"], outputSchemaRef: null, toolName: "jobs.search" }],
    completionCriteria: ["finish"], briefRationale: "bounded",
  }
  const tool = {
    execute: vi.fn(async (_context: unknown, call: { id: string; toolName: string; toolVersion: string; input: unknown }) => {
      calls.push(call.toolName)
      return { ...call, status: "completed" as const, output: call.toolName === "agent.plan.propose" ? { status: "accepted", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null, proposal, intents: [], proposalHash: fingerprintPlanProposal(proposal) } : { found: true }, errorCode: null }
    }),
    registry: {
      list: () => [
        { name: "agent.plan.propose", version: "1", risk: "internal_write", capabilities: ["coordination"] },
        { name: "jobs.search", version: "1", risk: "read", capabilities: ["read"] },
      ],
      validateArguments: () => true as const,
    },
    router: { execute: async (context: unknown, call: { id: string; toolName: string; toolVersion: string; input: unknown }) => tool.execute(context, call) },
  }
  const runtime = await createCanonicalTurnRuntime({ connect: vi.fn() } as never, {
    workerId: "worker-1", planningEnabled: true, planningExecutionEnabled, stateLoader: async () => state(), rootTaskStore: roots as never,
    modelRuntimeFactory: async () => ({ adapter: {
      ...model(() => []),
      async *stream() {
        modelCalls += 1
        if (modelCalls === 1) {
          yield { type: "tool_call_completed", callId: "plan-call", name: "agent.plan.propose", arguments: { proposal } }
          yield { type: "completed", finishReason: "tool_calls" }
        } else {
          yield { type: "text_delta", text: "done" }
          yield { type: "completed", finishReason: "stop" }
        }
      },
    }, registry: {} as never, candidates: [] }),
    toolRuntimeFactory: () => tool as never, turnEngineStoreFactory: () => store(events), contextBuilderFactory: () => contextBuilder(),
    authorizeUsage: async () => ({ settle: async () => undefined }),
  })
  const result = await runtime.execute({ lease, signal: new AbortController().signal })
  return { result, calls, events }
}

describe("createCanonicalTurnRuntime", () => {
  it("derives root coordination capability from the production gate", async () => {
    const disabled = await rootToolNames(false)
    expect(disabled).not.toEqual(expect.arrayContaining(["spawn_subagent", "wait_subagents", "list_subagents", "send_message", "interrupt_subagent", "close_subagent"]))
    const enabled = await rootToolNames(true)
    expect(enabled).toEqual(expect.arrayContaining(["spawn_subagent", "wait_subagents", "list_subagents", "send_message", "interrupt_subagent", "close_subagent"]))
  })

  it("derives root planning capability only from the planning gate", async () => {
    const forged = await rootToolNames(false, false, ["read", "canPlan"])
    expect(forged).not.toContain("agent.plan.propose")
    const enabled = await rootToolNames(false, true)
    expect(enabled).toContain("agent.plan.propose")
  })

  it("uses the default plan bridge only when planning execution is explicitly enabled", async () => {
    const disabled = await runDefaultPlanBridge(false)
    expect(disabled.result.status).toBe("completed")
    expect(disabled.calls).toEqual(["agent.plan.propose"])
    const enabled = await runDefaultPlanBridge(true)
    expect(enabled.result.status).toBe("completed")
    expect(enabled.calls).toEqual(["agent.plan.propose", "jobs.search"])
    expect(enabled.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "plan.command", correlationId: "plan-call", idempotencyKey: expect.stringContaining("plan-command"), owner: expect.objectContaining({ taskId: "root-1" }) })]))
  })

  it("keeps plan execution behind both server gates and passes server-owned context", async () => {
    const disabledFactory = vi.fn(() => async () => ({ observations: [] }))
    const disabled = setup({ planningEnabled: false, planningExecutionEnabled: true, planExecutionFactory: disabledFactory })
    const disabledRuntime = await disabled.runtime
    await disabledRuntime.execute({ lease, signal: new AbortController().signal })
    expect(disabledFactory).not.toHaveBeenCalled()

    const partialFactory = vi.fn(() => async () => ({ observations: [] }))
    const partial = setup({ planningEnabled: true, planningExecutionEnabled: false, planExecutionFactory: partialFactory })
    const partialRuntime = await partial.runtime
    await partialRuntime.execute({ lease, signal: new AbortController().signal })
    expect(partialFactory).not.toHaveBeenCalled()

    const enabledFactory = vi.fn((input: { rootTaskId: string; taskId: string; lease: typeof lease; router: unknown; registry: unknown; policy: unknown }) => {
      expect(input.rootTaskId).toBe("root-1")
      expect(input.taskId).toBe("root-1")
      expect(input.lease).toBe(lease)
      expect(input.router).toBeDefined()
      expect(input.registry).toBeDefined()
      expect(input.policy).toBeDefined()
      return async () => ({ observations: [] })
    })
    const enabled = setup({ planningEnabled: true, planningExecutionEnabled: true, planExecutionFactory: enabledFactory })
    const enabledRuntime = await enabled.runtime
    await enabledRuntime.execute({ lease, signal: new AbortController().signal })
    expect(enabledFactory).toHaveBeenCalledTimes(1)

    const noFactory = setup({ planningEnabled: true, planningExecutionEnabled: true })
    await (await noFactory.runtime).execute({ lease, signal: new AbortController().signal })
  })

  it("passes the recovered plan revision to the proposal and execution bridges", async () => {
    const factory = vi.fn((input: { initialPlanRevision?: number | null; initialPlanHashes?: readonly string[]; maxPlanRevisions?: number }) => {
      expect(input.initialPlanRevision).toBe(2)
      expect(input.initialPlanHashes).toEqual([recoveredPlanHash])
      expect(input.maxPlanRevisions).toBe(PLAN_MAX_REVISIONS)
      return async () => ({ observations: [] })
    })
    const fixture = setup({ planningEnabled: true, planningExecutionEnabled: true, stateLoader: async () => ({ ...state(), planRevision: 2, planProposalHashes: [recoveredPlanHash] }), planExecutionFactory: factory })
    await (await fixture.runtime).execute({ lease, signal: new AbortController().signal })
    expect(factory).toHaveBeenCalledTimes(1)
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

  it("composes a real model/tool continuation with runtime-owned root identity", async () => {
    const fixture = setup()
    const runtime = await fixture.runtime
    await expect(runtime.execute({ lease, signal: new AbortController().signal })).resolves.toMatchObject({ status: "completed" })
    expect(fixture.getModelCalls()).toBe(2)
    expect(fixture.tool.execute).toHaveBeenCalledWith(expect.objectContaining({ taskId: "root-1", rootTaskId: "root-1" }), expect.objectContaining({ toolName: "jobs.search" }))
    expect(fixture.roots.finish).toHaveBeenCalledWith(expect.objectContaining({ rootTaskId: "root-1", result: expect.objectContaining({ status: "completed" }) }))
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
