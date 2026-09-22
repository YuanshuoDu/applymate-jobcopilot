import { describe, expect, it, vi } from "vitest"
import { Type } from "@sinclair/typebox"
import { schemaVersion } from "@jobcopilot/agent-protocol"
import type { ModelAdapter, ModelStreamEvent, HarnessModelRequest } from "@jobcopilot/agent-model"

import { AgentTreeManager, type SubagentClock } from "../runtime/subagents/manager.js"
import type { SubagentExecutionResult, SubagentLease, SubagentStore, SubagentTaskRecord } from "../runtime/subagents/types.js"
import { createProductionChildExecutor } from "../runtime/subagents/production-child-runtime.js"
import type { TreeBudgetReservation, TreeBudgetReservationStore } from "../runtime/subagents/tree-budget-types.js"
import type { CoordinationStore, CoordinationTaskView, DurableWaitPort } from "../runtime/tools/coordination-types.js"
import { createCoordinationTools } from "../runtime/tools/coordination-tools.js"
import { createCanonicalPolicy } from "../runtime/policy/canonical-policy.js"
import type { createSubagentQueue } from "./subagent-queue.js"
import type { createTurnQueue } from "../runtime/turns/turn-queue.js"
import { createProductionWorkerBootstrap, type CanonicalTurnRuntime } from "./production-bootstrap.js"
import { createCanonicalTurnRuntime, type UsageAuthorization } from "../runtime/canonical-turn-runtime.js"
import { createTurnEngineExecutor } from "../runtime/turns/turn-engine.js"
import type { TurnEngineStore } from "../runtime/turns/turn-engine-types.js"
import { InMemoryToolLifecycleSink, ToolLifecycle } from "../runtime/tools/lifecycle.js"
import { InMemoryToolResultReferenceStore } from "../runtime/tools/redaction.js"
import { ToolRegistry } from "../runtime/tools/registry.js"
import { ToolRouter } from "../runtime/tools/router.js"
import type { PublicToolDefinition, RuntimeToolDefinition, ToolCallRequest, ToolRouterContext } from "../runtime/tools/types.js"
import type { ExecutionOwnerFence } from "../runtime/execution-owner.js"
import type { CanonicalTurnState } from "../runtime/canonical-turn-state.js"
import { StepContextBuilder } from "../runtime/context/step-context-builder.js"
import type { InputClaimStore, InputClaimTransaction } from "../runtime/context/input-claim-store.js"

function runtime(events: string[]): CanonicalTurnRuntime {
  const manager = { shutdown: vi.fn(async () => { events.push("manager.shutdown") }) } as unknown as AgentTreeManager
  return {
    execute: vi.fn(async () => {
      events.push("execute")
      return { status: "completed" as const, summary: "fixture" }
    }),
    manager,
    childExecutionEnabled: false,
    coordinationEnabled: false,
    close: vi.fn(async () => { events.push("runtime.close") }),
  }
}

function compositionStore(): TurnEngineStore {
  const items = new Map<string, { revision: number }>()
  return {
    startStep: async ({ stepId, ordinal }) => ({ id: stepId, ordinal }),
    updateStep: async () => undefined,
    createItem: async ({ itemId }) => {
      items.set(itemId, { revision: 0 })
      return { id: itemId, revision: 0 }
    },
    updateItem: async ({ itemId, expectedRevision }) => {
      const item = items.get(itemId)
      if (!item || item.revision !== expectedRevision) throw new Error(`Unknown fixture item ${itemId}`)
      item.revision += 1
      return { id: itemId, revision: item.revision }
    },
    appendEvent: async ({ id }) => ({ id }),
    recordFinalResponse: async () => undefined,
  }
}

async function compositionRuntime(): Promise<{ runtime: CanonicalTurnRuntime; tool: ReturnType<typeof vi.fn>; lifecycle: InMemoryToolLifecycleSink; requests: HarnessModelRequest[]; manager: AgentTreeManager }> {
  const tool = vi.fn(async (context: { scope: { userId: string } }) => ({ user: context.scope.userId }))
  const definition: RuntimeToolDefinition = {
    schemaVersion, name: "fixture.read", version: "1", description: "Read deterministic fixture state",
    capabilities: ["read"] as const, inputSchema: Type.Object({}, { additionalProperties: false }),
    outputSchema: Type.Object({ user: Type.String() }, { additionalProperties: false }), risk: "read" as const,
    domain: "jobs" as const, idempotency: "read_only" as const, timeoutMs: 1_000, requiredCapabilities: [] as const,
    execute: tool,
  }
  const registry = new ToolRegistry([definition])
  const lifecycle = new InMemoryToolLifecycleSink()
  const router = new ToolRouter(registry, new ToolLifecycle({ sink: lifecycle, references: new InMemoryToolResultReferenceStore() }))
  let calls = 0
  const requests: HarnessModelRequest[] = []
  const model: ModelAdapter = {
    id: "fixture-model",
    profile: {
      provider: "fixture", model: "fixture", nativeTools: true, structuredOutput: true, streaming: true,
      continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false,
      supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false,
      supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 128, costClass: "low",
    },
    async *stream(request: HarnessModelRequest): AsyncIterable<ModelStreamEvent> {
      requests.push(request)
      calls += 1
      if (calls === 1) {
        yield { type: "tool_call_completed", callId: "fixture-call", name: "fixture.read", arguments: {} }
        yield { type: "completed", finishReason: "tool_calls" }
      } else {
        yield { type: "text_delta", text: "Fixture execution completed." }
        yield { type: "completed", finishReason: "stop" }
      }
    },
  }
  const manager = { shutdown: vi.fn(async () => undefined) } as unknown as AgentTreeManager
  const state: CanonicalTurnState = {
    scope: { userId: "user_fixture" }, goal: "Read fixture state", modelProfileSnapshot: {} as never,
    toolPolicySnapshot: { role: "orchestrator", capabilities: ["read"] }, budgetSnapshot: { limits: { maxSteps: 2 } },
    snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] },
  }
  const runtime = await createCanonicalTurnRuntime({ connect: vi.fn() } as never, {
    workerId: "worker_fixture", manager, stateLoader: async () => state,
    modelRuntimeFactory: async () => ({ adapter: model, registry: {} as never, candidates: [] }),
    toolRuntimeFactory: () => ({ registry, router }),
    rootTaskStore: {
      ensure: vi.fn(async () => ({ id: "root_fixture" } as never)),
      finish: vi.fn(async () => undefined),
    },
    turnEngineStoreFactory: () => compositionStore(),
    contextBuilderFactory: () => {
      const checkpoints = new Map<string, { inputThroughSequence: bigint; consumedInputIds: readonly string[] }>()
      const inputStore = {
        scope: { userId: "user_fixture" },
        withTransaction: async <T>(work: (transaction: InputClaimTransaction) => Promise<T>): Promise<T> => work({
          getCheckpoint: async ({ stepId }) => checkpoints.get(stepId) ?? { inputThroughSequence: 0n, consumedInputIds: [] },
          claimInputs: async () => ({ inputs: [], newlyClaimedInputIds: [] }),
          persistCheckpoint: async ({ stepId, checkpoint }) => { checkpoints.set(stepId, checkpoint) },
        }),
      } satisfies InputClaimStore
      return new StepContextBuilder(inputStore)
    },
    authorizeUsage: vi.fn(async () => ({ settle: vi.fn(async (_input: Parameters<UsageAuthorization["settle"]>[0]) => undefined) })),
  })
  return {
    runtime, tool, lifecycle, requests, manager,
  }
}

async function coordinationRuntime(input: { manager: AgentTreeManager; store: CoordinationStore; wait: DurableWaitPort; model: ModelAdapter }): Promise<{ runtime: CanonicalTurnRuntime; execute: CanonicalTurnRuntime["execute"] }> {
  const read: RuntimeToolDefinition = { schemaVersion, name: "fixture.read", version: "1", description: "Read fixture evidence", capabilities: ["read"], inputSchema: Type.Object({}, { additionalProperties: false }), outputSchema: Type.Object({ jobs: Type.Array(Type.Object({ id: Type.String() }, { additionalProperties: false })) }, { additionalProperties: false }), risk: "read", domain: "jobs", idempotency: "read_only", timeoutMs: 1_000, requiredCapabilities: [], execute: async () => ({ jobs: [{ id: "job-fixture" }] }) }
  const registry = new ToolRegistry([read, ...createCoordinationTools({ manager: input.manager, store: input.store, wait: input.wait })])
  const router = new ToolRouter(registry, new ToolLifecycle({ sink: new InMemoryToolLifecycleSink(), references: new InMemoryToolResultReferenceStore() }), createCanonicalPolicy(undefined, true, false))
  const state: CanonicalTurnState = { scope: { userId: "user_fixture" }, goal: "Read fixture state", modelProfileSnapshot: {} as never, toolPolicySnapshot: { role: "orchestrator", capabilities: ["read", "coordination"] }, budgetSnapshot: { limits: { maxSteps: 5 } }, snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] } }
  const runtime = await createCanonicalTurnRuntime({ connect: vi.fn() } as never, { workerId: "worker_fixture", manager: input.manager, coordinationEnabled: true, stateLoader: async () => state, modelRuntimeFactory: async () => ({ adapter: input.model, registry: {} as never, candidates: [] }), toolRuntimeFactory: () => ({ registry, router }), rootTaskStore: { ensure: vi.fn(async () => ({ id: "root_fixture" } as never)), finish: vi.fn(async () => undefined) }, turnEngineStoreFactory: () => compositionStore(), contextBuilderFactory: () => new StepContextBuilder({ scope: { userId: "user_fixture" }, withTransaction: async work => work({ getCheckpoint: async () => ({ inputThroughSequence: 0n, consumedInputIds: [] }), claimInputs: async () => ({ inputs: [], newlyClaimedInputIds: [] }), persistCheckpoint: async () => undefined }) } satisfies InputClaimStore), authorizeUsage: vi.fn(async () => ({ settle: vi.fn(async () => undefined) })) })
  return { runtime, execute: runtime.execute }
}

describe("production Worker bootstrap", () => {
  it("binds the canonical executor to the turn consumer and closes recovery before execution resources", async () => {
    const events: string[] = []
    const canonical = runtime(events)
    let turnOptions: Parameters<typeof createTurnQueue>[0] | undefined
    const turnQueue = {
      queue: { add: vi.fn(), close: vi.fn(async () => { events.push("turn.queue.close") }) },
      worker: { pause: vi.fn(async () => { events.push("turn.pause") }), close: vi.fn(async () => { events.push("turn.worker.close") }) },
      active: { size: 0, add: vi.fn(), remove: vi.fn(), values: vi.fn(() => []) },
      close: vi.fn(async () => { events.push("turn.close") }),
    } as unknown as ReturnType<typeof createTurnQueue>
    const turnRecovery = { close: vi.fn(async () => { events.push("turn.recovery.close") }) }
    const turns = ((input: Parameters<typeof createTurnQueue>[0]) => {
      turnOptions = input
      return turnQueue
    }) as unknown as Parameters<typeof createProductionWorkerBootstrap>[0]["turnQueueFactory"]
    const recover = (() => turnRecovery) as unknown as Parameters<typeof createProductionWorkerBootstrap>[0]["turnRecoveryFactory"]
    const waitResolverFactory = vi.fn()

    const bootstrap = await createProductionWorkerBootstrap({
      pool: { connect: vi.fn() },
      runtime: canonical,
      turnQueueFactory: turns,
      turnRecoveryFactory: recover,
      waitResolverFactory,
    })

    expect(turnOptions?.execute).toBe(canonical.execute)
    await turnOptions?.execute({ lease: {} as never, signal: new AbortController().signal })
    expect(events).toEqual(["execute"])

    await bootstrap.close()
    await bootstrap.close()
    expect(events).toEqual(["execute", "turn.pause", "turn.recovery.close", "turn.close", "manager.shutdown", "runtime.close"])
    expect(waitResolverFactory).not.toHaveBeenCalled()
  })

  it("starts and closes the dependency resolver only when explicitly configured", async () => {
    const canonical = runtime([])
    const turnQueueFactory = vi.fn(() => ({ queue: { add: vi.fn() }, worker: {}, active: { size: 0, values: () => [] }, close: vi.fn() }) as never)
    const turnRecoveryFactory = vi.fn(() => ({ close: vi.fn(async () => undefined) })) as never
    const resolver = { close: vi.fn(async () => undefined) }
    const resolverFactory = vi.fn(() => resolver)
    const bootstrap = await createProductionWorkerBootstrap({
      pool: { connect: vi.fn() }, runtime: canonical,
      turnQueueFactory: turnQueueFactory as never, turnRecoveryFactory,
      waitResolver: { intervalMs: 60_000, batchSize: 1 }, waitResolverFactory: resolverFactory,
    })
    expect(resolverFactory).toHaveBeenCalledWith(expect.anything(), { intervalMs: 60_000, batchSize: 1 })
    expect(bootstrap.waitResolver).toBe(resolver)
    await bootstrap.close()
    expect(resolver.close).toHaveBeenCalledOnce()
  })

  it("fails closed when child execution is enabled without a child consumer", async () => {
    const events: string[] = []
    const canonical = { ...runtime(events), childExecutionEnabled: true }
    const turnQueueFactory = vi.fn()

    await expect(createProductionWorkerBootstrap({
      pool: { connect: vi.fn() }, runtime: canonical,
      turnQueueFactory: turnQueueFactory as never,
      turnRecoveryFactory: vi.fn() as never,
    })).rejects.toThrow("canonical_child_execution_unconfigured")

    expect(turnQueueFactory).not.toHaveBeenCalled()
    expect(canonical.close).toHaveBeenCalledOnce()
  })

  it("fails closed when coordination is enabled without a wait resolver", async () => {
    const events: string[] = []
    const canonical = { ...runtime(events), childExecutionEnabled: true, coordinationEnabled: true }
    const turnQueueFactory = vi.fn()

    await expect(createProductionWorkerBootstrap({
      pool: { connect: vi.fn() }, runtime: canonical,
      turnQueueFactory: turnQueueFactory as never,
      turnRecoveryFactory: vi.fn() as never,
      subagents: { execute: vi.fn(async () => ({ status: "completed" as const })) },
    })).rejects.toThrow("canonical_wait_resolver_unconfigured")

    expect(turnQueueFactory).not.toHaveBeenCalled()
    expect(canonical.close).toHaveBeenCalledOnce()
  })

  it("keeps child queue registration behind an explicit executor seam", async () => {
    const events: string[] = []
    const canonical = runtime(events)
    const childQueue = {
      queue: { add: vi.fn(), close: vi.fn() },
      worker: { pause: vi.fn(async () => { events.push("child.pause") }), close: vi.fn() },
      close: vi.fn(async () => { events.push("child.close") }),
    } as unknown as ReturnType<typeof createSubagentQueue>
    const childRecovery = { close: vi.fn(async () => { events.push("child.recovery.close") }) }
    const childFactory = vi.fn(() => childQueue) as unknown as Parameters<typeof createProductionWorkerBootstrap>[0]["subagents"] extends infer T
      ? T extends { queueFactory?: infer F } ? F : never : never
    const recoveryFactory = vi.fn(() => childRecovery) as unknown as Parameters<typeof createProductionWorkerBootstrap>[0]["subagents"] extends infer T
      ? T extends { recoveryFactory?: infer F } ? F : never : never

    const bootstrap = await createProductionWorkerBootstrap({
      pool: { connect: vi.fn() },
      runtime: canonical,
      turnQueueFactory: (() => ({ queue: { add: vi.fn() }, worker: {}, active: { size: 0, values: () => [] }, close: vi.fn() })) as never,
      turnRecoveryFactory: (() => ({ close: vi.fn() })) as never,
      subagents: {
        execute: vi.fn(async () => ({ status: "completed" as const })),
        queueFactory: childFactory,
        recoveryFactory,
      },
    })

    expect(bootstrap.subagents).toBeDefined()
    expect(childFactory).toHaveBeenCalledWith(expect.objectContaining({ manager: canonical.manager }))
    await bootstrap.close()
    expect(events).toEqual(["child.pause", "child.recovery.close", "manager.shutdown", "child.close", "runtime.close"])
  })

  it("closes every resource when shutdown encounters an error and is idempotent", async () => {
    const events: string[] = []
    const canonical = runtime(events)
    const turnQueue = {
      queue: { add: vi.fn() },
      worker: { pause: vi.fn(async () => { events.push("turn.pause") }) },
      active: { size: 0, values: () => [] },
      close: vi.fn(async () => {
        events.push("turn.close")
        throw new Error("turn close failed")
      }),
    } as unknown as ReturnType<typeof createTurnQueue>
    const turnRecovery = {
      close: vi.fn(async () => {
        events.push("turn.recovery.close")
        throw new Error("recovery close failed")
      }),
    }

    const bootstrap = await createProductionWorkerBootstrap({
      pool: { connect: vi.fn() },
      runtime: canonical,
      turnQueueFactory: vi.fn(() => turnQueue) as unknown as Parameters<typeof createProductionWorkerBootstrap>[0]["turnQueueFactory"],
      turnRecoveryFactory: vi.fn(() => turnRecovery) as unknown as Parameters<typeof createProductionWorkerBootstrap>[0]["turnRecoveryFactory"],
    })

    await expect(bootstrap.close()).rejects.toThrow("recovery close failed")
    await bootstrap.close()
    expect(events).toEqual(["turn.pause", "turn.recovery.close", "turn.close", "manager.shutdown", "runtime.close"])
    expect(turnRecovery.close).toHaveBeenCalledTimes(1)
    expect(turnQueue.close).toHaveBeenCalledTimes(1)
    expect(canonical.close).toHaveBeenCalledTimes(1)
  })

  it("cleans up the canonical runtime when turn construction fails", async () => {
    const events: string[] = []
    const canonical = runtime(events)
    const failure = new Error("turn construction failed")
    const turnFactory = vi.fn(() => { throw failure }) as unknown as Parameters<typeof createProductionWorkerBootstrap>[0]["turnQueueFactory"]

    await expect(createProductionWorkerBootstrap({
      pool: { connect: vi.fn() },
      runtime: canonical,
      turnQueueFactory: turnFactory,
      turnRecoveryFactory: vi.fn(() => ({ close: vi.fn() })) as unknown as Parameters<typeof createProductionWorkerBootstrap>[0]["turnRecoveryFactory"],
    })).rejects.toBe(failure)
    expect(events).toEqual(["runtime.close"])
    expect(canonical.close).toHaveBeenCalledTimes(1)
  })

  it("releases active turns when recovery scanner startup fails", async () => {
    const events: string[] = []
    const canonical = runtime(events)
    const lease = {
      turnId: "turn_startup_failure", sessionId: "session_startup_failure", ownerId: "worker_fixture", userId: "user_fixture", leaseVersion: 3,
      leaseStartedAt: new Date("2026-09-01T00:00:00.000Z"), leaseExpiresAt: new Date("2026-09-01T00:10:00.000Z"),
    }
    const abort = vi.fn(async () => { events.push("turn.abort") })
    const active = { values: () => [{ lease, abort }] }
    const queries: string[] = []
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql)
        if (sql.includes('SELECT session."id"')) return { rows: [{ id: lease.sessionId }], rowCount: 1 }
        if (sql.includes('UPDATE "agent_turns"')) return { rows: [], rowCount: 1 }
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    const pool = { connect: vi.fn(async () => client) }
    const turnQueue = {
      queue: { add: vi.fn() },
      worker: { pause: vi.fn(async () => { events.push("turn.pause") }) },
      active,
      close: vi.fn(async () => { events.push("turn.close") }),
    } as unknown as ReturnType<typeof createTurnQueue>
    const failure = new Error("recovery scanner startup failed")

    await expect(createProductionWorkerBootstrap({
      pool: pool as never,
      runtime: canonical,
      turnQueueFactory: vi.fn(() => turnQueue) as unknown as Parameters<typeof createProductionWorkerBootstrap>[0]["turnQueueFactory"],
      turnRecoveryFactory: vi.fn(() => { throw failure }) as unknown as Parameters<typeof createProductionWorkerBootstrap>[0]["turnRecoveryFactory"],
    })).rejects.toBe(failure)

    expect(events).toEqual(["turn.pause", "turn.abort", "turn.close", "manager.shutdown", "runtime.close"])
    expect(queries.some(sql => sql.includes('SET "status" = $5'))).toBe(true)
    expect(canonical.close).toHaveBeenCalledOnce()
  })

  it("runs the same bootstrap binding through TurnEngine and ToolRouter with a deterministic model", async () => {
    const fixture = await compositionRuntime()
    let execute: CanonicalTurnRuntime["execute"] | undefined
    const lease = {
      turnId: "turn_fixture", sessionId: "session_fixture", ownerId: "worker_fixture", userId: "user_fixture", leaseVersion: 1,
      leaseStartedAt: new Date("2026-09-01T00:00:00.000Z"), leaseExpiresAt: new Date("2026-09-01T00:10:00.000Z"),
    }
    const bootstrap = await createProductionWorkerBootstrap({
      pool: { connect: vi.fn() }, runtime: fixture.runtime,
      turnQueueFactory: vi.fn((options) => {
        execute = options.execute
        return { queue: { add: vi.fn() }, worker: {}, active: { size: 0, values: () => [] }, close: vi.fn(async () => undefined) } as never
      }) as unknown as Parameters<typeof createProductionWorkerBootstrap>[0]["turnQueueFactory"],
      turnRecoveryFactory: vi.fn(() => ({ close: vi.fn(async () => undefined) })) as unknown as Parameters<typeof createProductionWorkerBootstrap>[0]["turnRecoveryFactory"],
    })

    const result = await execute!({ lease, signal: new AbortController().signal })

    expect(result).toMatchObject({ status: "completed" })
    expect(fixture.tool).toHaveBeenCalledWith(expect.objectContaining({ scope: { userId: "user_fixture" } }), {})
    expect(fixture.lifecycle.events.map((event) => event.phase)).toEqual(["started", "completed"])
    expect(fixture.requests).toHaveLength(2)
    expect(JSON.stringify(fixture.requests[1]?.messages)).toContain("fixture-call")
    expect(JSON.stringify(fixture.requests[1]?.messages)).toContain("user_fixture")
    await bootstrap.close()
    expect(fixture.manager.shutdown).toHaveBeenCalledOnce()
  })

  it("composes root TurnEngine coordination with a leased child execution and wait closure", async () => {
    const now = new Date("2026-09-01T00:00:00.000Z")
    const child: SubagentTaskRecord = { id: "child_fixture", userId: "user_fixture", sessionId: "session_fixture", turnId: "turn_fixture", rootTaskId: "root_fixture", parentTaskId: "root_fixture", path: "/root_fixture/child_fixture", depth: 1, role: "scout", taskType: "research", status: "queued", goal: "Find fixture evidence", constraints: [], successCriteria: [], allowedActions: ["fixture.read"], context: null, expectedOutputSchema: null, result: null, failureReason: null, attemptCount: 0, maxAttempts: 3, nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null, budgetSnapshot: { limits: { maxSteps: 4 }, subagentPolicy: { maxAttempts: 3 } }, toolPolicySnapshot: { capabilities: ["read"] } }
    const rootTask: SubagentTaskRecord = { ...child, id: "root_fixture", parentTaskId: null, path: "/root_fixture", depth: 0, role: "orchestrator", taskType: "turn", status: "running" }
    const tasks = new Map([[child.id, child]])
    const clock: SubagentClock = { setInterval: () => 1 as never, clearInterval: vi.fn() }
    const store: SubagentStore = { async create() { throw new Error("non_atomic") }, async createWithSpawn(input) { tasks.set(child.id, { ...child, role: input.role, taskType: input.taskType, goal: input.goal }); return { task: tasks.get(child.id)!, duplicate: false } }, async get(id) { return id === rootTask.id ? rootTask : tasks.get(id) ?? null }, async claim(input) { const value = tasks.get(input.taskId); if (!value || value.status !== "queued") return null; const leased = { ...value, status: "running" as const, attemptCount: 1, leaseOwner: input.ownerId, leaseExpiresAt: new Date(now.getTime() + 60_000) }; tasks.set(value.id, leased); return leased }, async heartbeat() { return "renewed" }, async finish(input) { const value = tasks.get(input.taskId); if (!value || value.leaseOwner !== input.ownerId) return null; tasks.set(value.id, { ...value, status: input.status, result: input.result ?? null }); return input.status }, async close() { return false }, async interruptTree() { return 0 }, async recoverExpired() { return [] } }
    const manager = new AgentTreeManager(store, { now: () => now, clock })
    const rootView: CoordinationTaskView = { ...child, id: "root_fixture", parentTaskId: null, path: "/root_fixture", depth: 0, role: "orchestrator", taskType: "turn", status: "running" }
    const view = (): CoordinationTaskView => ({ ...tasks.get(child.id)! })
    const replays = new Map<string, CoordinationTaskView>()
    const coordinationStore: CoordinationStore = { getTask: async input => input.taskId === "root_fixture" ? rootView : view(), listTasks: async () => [view()], sendMessage: vi.fn(), getSpawnReplay: async input => replays.get(input.idempotencyKey) ?? null, recordSpawn: async input => { replays.set(input.idempotencyKey, input.task); return true }, appendActivity: async () => undefined }
    const childRequests: HarnessModelRequest[] = []
    const childToolCalls: Array<{ context: ToolRouterContext; request: ToolCallRequest }> = []
    let childModelCalls = 0
    const childModel: ModelAdapter = {
      id: "fixture-child-model",
      profile: { provider: "fixture", model: "fixture-child", nativeTools: true, structuredOutput: true, streaming: true, continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false, supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false, supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 128, costClass: "low" },
      async *stream(request) {
        childRequests.push(request)
        childModelCalls += 1
        if (childModelCalls === 1) yield* [{ type: "tool_call_completed", callId: "child-read", name: "fixture.read", arguments: {} }, { type: "completed", finishReason: "tool_calls" }]
        else yield* [{ type: "text_delta", text: "Child found job-fixture." }, { type: "completed", finishReason: "stop" }]
      },
    }
    const childTool = vi.fn(async (userId: string) => ({ child: userId, evidence: "job-fixture" }))
    const childDefinition: PublicToolDefinition = { schemaVersion, name: "fixture.read", version: "1", description: "Read deterministic child evidence", capabilities: ["read"], inputSchema: Type.Object({}, { additionalProperties: false }), outputSchema: Type.Object({ child: Type.String(), evidence: Type.String() }, { additionalProperties: false }), risk: "read", domain: "jobs", idempotency: "read_only", timeoutMs: 1_000, requiredCapabilities: [] }
    const childRouter = vi.fn(async (context: ToolRouterContext, request: ToolCallRequest) => {
      childToolCalls.push({ context, request })
      return { id: request.id, toolName: request.toolName, toolVersion: request.toolVersion, status: "completed" as const, output: await childTool(context.scope.userId), errorCode: null }
    })
    const childTurnStore = compositionStore()
    const childBudgetReservations: TreeBudgetReservation[] = []
    const childBudget: TreeBudgetReservationStore = {
      reserve: vi.fn(async input => {
        const timestamp = input.now ?? now
        const reservation: TreeBudgetReservation = { ...input, id: `child-budget:${childBudgetReservations.length + 1}`, units: 1, status: "reserved", createdAt: timestamp, updatedAt: timestamp, settledAt: null }
        childBudgetReservations.push(reservation)
        return reservation
      }),
      settle: vi.fn(async input => {
        const index = childBudgetReservations.findIndex(reservation => reservation.id === input.id)
        if (index < 0) throw new Error(`Unknown child budget reservation ${input.id}`)
        const timestamp = input.now ?? now
        const reservation: TreeBudgetReservation = { ...childBudgetReservations[index]!, status: input.status, updatedAt: timestamp, settledAt: timestamp }
        childBudgetReservations[index] = reservation
        return reservation
      }),
    }
    const childModelRuntimeFactory = vi.fn(() => childModel)
    const childToolRuntimeFactory = vi.fn(({ task, lease, owner }: { task: SubagentTaskRecord; lease: SubagentLease; owner: ExecutionOwnerFence }) => {
      expect(task.id).toBe(child.id)
      expect(lease.id).toBe(child.id)
      expect(owner).toMatchObject({ taskId: child.id, rootTaskId: "root_fixture", ownerId: "queue_fixture", attemptCount: 1 })
      return { definitions: [childDefinition], router: { execute: childRouter } }
    })
    const childExecutor = createProductionChildExecutor({
      pool: { connect: vi.fn() } as never,
      turnStore: childTurnStore,
      treeBudget: childBudget,
      authorizeUsage: vi.fn(async () => ({ settle: vi.fn(async () => undefined) })),
      modelRuntimeFactory: childModelRuntimeFactory,
      toolRuntimeFactory: childToolRuntimeFactory,
    })
    let bootstrappedChildExecutor: ((input: { lease: SubagentLease }) => Promise<SubagentExecutionResult>) | undefined
    let waitCalls = 0
    const wait: DurableWaitPort = { wait: async input => { waitCalls += 1; expect(bootstrappedChildExecutor).toBe(childExecutor); const outcome = await manager.run({ taskId: child.id, sessionId: input.sessionId, rootTaskId: "root_fixture", ownerId: "queue_fixture" }, bootstrappedChildExecutor!); expect(outcome.status).toBe("completed"); expect(tasks.get(child.id)?.result).toMatchObject({ status: "completed", toolCallCount: 1 }); return { waitId: "wait_fixture", status: "ready", deadlineAt: now.toISOString(), matchedTaskIds: [child.id] } } }
    const requests: HarnessModelRequest[] = []
    let calls = 0
    const model: ModelAdapter = { id: "fixture-model", profile: { provider: "fixture", model: "fixture", nativeTools: true, structuredOutput: true, streaming: true, continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false, supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false, supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 128, costClass: "low" }, async *stream(request) { requests.push(request); calls += 1; if (calls === 1) yield* [{ type: "tool_call_completed", callId: "spawn", name: "agent.spawn", arguments: { idempotencyKey: "spawn_fixture", role: "scout", taskType: "research", goal: "Find fixture evidence" } }, { type: "completed", finishReason: "tool_calls" }]; else if (calls === 2) yield* [{ type: "tool_call_completed", callId: "wait", name: "agent.wait", arguments: { idempotencyKey: "wait_fixture", taskIds: [child.id], mode: "all", timeoutMs: 1_000 } }, { type: "completed", finishReason: "tool_calls" }]; else if (calls === 3) yield* [{ type: "tool_call_completed", callId: "read", name: "fixture.read", arguments: {} }, { type: "completed", finishReason: "tool_calls" }]; else yield* [{ type: "text_delta", text: "Found job-fixture." }, { type: "completed", finishReason: "stop" }] } }
    const fixture = await coordinationRuntime({ manager, store: coordinationStore, wait, model })
    let execute: CanonicalTurnRuntime["execute"] | undefined
    const childQueueFactory = vi.fn(options => {
      bootstrappedChildExecutor = options.execute as typeof childExecutor
      return { queue: { add: vi.fn() }, worker: {}, close: vi.fn(async () => undefined) } as never
    })
    const bootstrap = await createProductionWorkerBootstrap({
      pool: { connect: vi.fn() },
      runtime: fixture.runtime,
      turnQueueFactory: vi.fn(options => {
        execute = options.execute
        return { queue: { add: vi.fn() }, worker: {}, active: { size: 0, values: () => [] }, close: vi.fn(async () => undefined) } as never
      }) as never,
      turnRecoveryFactory: vi.fn(() => ({ close: vi.fn(async () => undefined) })) as never,
      waitResolver: { intervalMs: 60_000, batchSize: 1 },
      waitResolverFactory: vi.fn(() => ({ close: vi.fn(async () => undefined) })) as never,
      subagents: {
        execute: childExecutor,
        queueFactory: childQueueFactory as never,
        recoveryFactory: vi.fn(() => ({ close: vi.fn(async () => undefined) })) as never,
      },
    })
    expect(bootstrap.subagents).toBeDefined()
    expect(bootstrap.waitResolver).toBeDefined()
    expect(childQueueFactory).toHaveBeenCalledWith(expect.objectContaining({ execute: childExecutor, manager }))
    const result = await execute!({ lease: { turnId: "turn_fixture", sessionId: "session_fixture", ownerId: "worker_fixture", userId: "user_fixture", leaseVersion: 1, leaseStartedAt: now, leaseExpiresAt: new Date(now.getTime() + 60_000) } as never, signal: new AbortController().signal })
    expect(result).toMatchObject({ status: "completed" }); expect(waitCalls).toBe(1); expect(tasks.get(child.id)?.status).toBe("completed"); expect(childModelRuntimeFactory).toHaveBeenCalledOnce(); expect(childToolRuntimeFactory).toHaveBeenCalledOnce(); expect(childRequests).toHaveLength(2); expect(childRequests[0]?.tools).toEqual([expect.objectContaining({ name: "fixture.read" })]); expect(childTool).toHaveBeenCalledOnce(); expect(childToolCalls).toHaveLength(1); expect(childToolCalls[0]?.context).toMatchObject({ taskId: child.id, rootTaskId: "root_fixture", actorRole: "subagent" }); expect(childBudget.reserve).toHaveBeenCalledTimes(2); expect(childBudget.settle).toHaveBeenCalledTimes(2); expect(childBudgetReservations.every(reservation => reservation.status === "consumed")).toBe(true); expect(requests).toHaveLength(4); expect(JSON.stringify(requests[2]?.messages)).toContain("job-fixture")
    await bootstrap.close()
  })
})
