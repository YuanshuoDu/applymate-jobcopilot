import { describe, expect, it, vi } from "vitest"

vi.mock("ioredis", () => ({ Redis: vi.fn().mockImplementation(() => ({ disconnect: vi.fn() })) }))
vi.mock("./selected-job-preparation.js", () => ({ loadSelectedJobPreparation: vi.fn(async () => undefined) }))

import type { HarnessModelRequest, ModelAdapter, ModelStreamEvent } from "@jobcopilot/agent-model"
import type pg from "pg"
import type { StepContext } from "./context/step-context-builder.js"
import type { CanonicalTurnState } from "./canonical-turn-state.js"
import type { TurnEngineEvent, TurnEngineStore } from "./turns/turn-engine-types.js"
import { createCanonicalTurnRuntime } from "./canonical-turn-runtime.js"
import { TASK_GRAPH_RESULT_PROJECTION_SCHEMA, type TaskGraphCommandPort, type TaskGraphCurrentState, type TaskGraphReadScope, type TaskGraphTaskTemplate } from "./subagents/task-graph-command-port.js"
import { loadCanonicalTurnState } from "./canonical-turn-state.js"
import { TurnEngine } from "./turns/turn-engine.js"
import { createPgRootTaskStore } from "./subagents/root-task-store.js"
import { reclaimExpiredTurns } from "./turns/recovery-scanner.js"
import { runTurnJob } from "./turns/turn-queue.js"
import type { TurnLease } from "./turns/lease.js"
import { InterruptRequestedError } from "./interrupt/registry.js"
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

function selectedJobState(): CanonicalTurnState {
  const current = state()
  return { ...current, snapshot: { ...current.snapshot, businessRefs: [{ id: "job-1", kind: "job", ownerId: "user-1", label: "Selected role" }] } }
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
  return { ensure: vi.fn(async () => ({ id: "root-1", attemptCount: 1 } as never)), checkCompletion: vi.fn(async () => ({ ok: true as const })), finish: vi.fn(async () => undefined) }
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

async function rootToolNames(
  coordinationEnabled: boolean,
  capabilities = ["read"],
  productionFlags?: ProductionAgentFlags,
  taskGraph?: { commandPort: TaskGraphCommandPort; templates: Readonly<Record<string, TaskGraphTaskTemplate>> },
  selectedJobPreparation?: { readonly jobId: string },
): Promise<string[]> {
  const requests: HarnessModelRequest[] = []
  const runtime = await createCanonicalTurnRuntime({ connect: vi.fn() } as never, {
    workerId: "worker-1", coordinationEnabled, ...(productionFlags ? { productionFlags } : {}),
    ...(taskGraph ? { taskGraphCommandPort: taskGraph.commandPort, taskGraphTemplates: taskGraph.templates } : {}),
    ...(selectedJobPreparation ? { selectedJobPreparationLoader: async () => selectedJobPreparation } : {}),
    stateLoader: async () => ({ ...state(), toolPolicySnapshot: { capabilities } }),
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

async function taskGraphRootSurface(
  selectedJob: boolean,
  recoverHiddenMutation = false,
  forgedToolName = "agent.spawn",
  recoveredToolName = "agent.interrupt",
) {
  const requests: HarnessModelRequest[] = []
  const events: RuntimeEvent[] = []
  let allowedActions: readonly string[] = []
  const roots = {
    ensure: vi.fn(async (input: { allowedActions: readonly string[] }) => {
      allowedActions = [...input.allowedActions]
      return { id: "root-1", attemptCount: 1 } as never
    }),
    checkCompletion: vi.fn(async () => ({ ok: true as const })), finish: vi.fn(async () => undefined),
  }
  const names = [...CANONICAL_COORDINATION_TOOL_NAMES,
    "spawn_subagent", "send_message", "wait_subagents", "list_subagents", "interrupt_subagent", "close_subagent"]
  const definitions = ["jobs.search", "jobs.get", "persona.retrieve", "resume.get_base", ...names].map(name => ({ name, version: "1" }))
  const route = vi.fn(async (_context: unknown, call: { id: string; toolName: string; toolVersion: string }) => ({
    id: call.id, toolName: call.toolName, toolVersion: call.toolVersion, status: "completed" as const,
    output: { ok: true, privateSource: "PRIVATE_SOURCE_SENTINEL" }, errorCode: null,
  }))
  const taskGraphCommandPort = {
    appendAndSchedule: vi.fn(async () => ({ status: "accepted" as const, revision: 1, nodes: [], readyTaskIds: [] })),
    readCurrent: vi.fn(async () => ({ revision: 0, nodes: [] })),
  }
  const runtime = await createCanonicalTurnRuntime({ connect: vi.fn() } as never, {
    workerId: "worker-1", productionFlags: resolveProductionAgentFlags({
      ENABLE_AGENT_TASK_GRAPH_PLANNING: "1", ENABLE_AGENT_CHILD_EXECUTION: "1", ENABLE_AGENT_WAIT_RESOLVER: "1",
    }),
    taskGraphCommandPort: taskGraphCommandPort as never,
    taskGraphTemplates: { scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] } },
    selectedJobPreparationLoader: async () => selectedJob ? { jobId: "job-1" } : undefined,
    stateLoader: async () => ({
      ...state(), toolPolicySnapshot: { capabilities: ["read"] },
      ...(recoverHiddenMutation ? {
        pendingToolCalls: [{ call: { id: "persisted-hidden-call", name: recoveredToolName, arguments: recoveredToolName === "jobs.get" ? { jobId: "job-other" } : {} }, toolVersion: "1", stepId: "prior-step", callItem: { id: "persisted-call-item", revision: 0 } }],
        resume: { nextOrdinal: 1, stepCount: 1, toolCallCount: 1, inputThroughSequence: 0n, consumedInputIds: [], usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } },
      } : {}),
    }),
    rootTaskStore: roots as never, turnEngineStoreFactory: () => store(events), contextBuilderFactory: () => contextBuilder(),
    toolRuntimeFactory: () => ({
      registry: {
        list: () => definitions,
        resolve: (name: string) => ({ idempotency: name === "agent.interrupt" ? "idempotent" as const : name === "agent.spawn" ? "requires_key" as const : "read_only" as const }),
        validateArguments: () => true as const,
        register: (definition: { name: string; version: string }) => { definitions.push(definition) },
      },
      router: { execute: route },
    }) as never,
    modelRuntimeFactory: async () => ({ adapter: {
      ...model(() => []),
      async *stream(request: HarnessModelRequest) {
        requests.push(request)
        if (requests.length === 1 && !recoverHiddenMutation) {
          yield { type: "tool_call_completed", callId: "forged-call", name: forgedToolName, arguments: { jobId: "job-other" } }
          yield { type: "completed", finishReason: "tool_calls" }
        } else {
          yield { type: "text_delta", text: "done" }
          yield { type: "completed", finishReason: "stop" }
        }
      },
    }, registry: {} as never, candidates: [] }),
    authorizeUsage: async () => ({ settle: async () => undefined }),
  })
  await runtime.execute({ lease, signal: new AbortController().signal })
  const toolNames = requests[0]?.tools.flatMap(tool => {
    if (!tool || typeof tool !== "object" || !("name" in tool) || typeof tool.name !== "string") return []
    return [tool.name]
  }) ?? []
  return { toolNames, allowedActions, route, events }
}

describe("createCanonicalTurnRuntime", () => {
  it("surfaces selected-job preparation as unavailable without planning gates, model calls, or task scheduling", async () => {
    const roots = rootStore()
    const modelRuntimeFactory = vi.fn(async () => ({ adapter: model(() => []), registry: {} as never, candidates: [] }))
    const executionProjection = { start: vi.fn(async () => undefined), finish: vi.fn(async () => undefined) }
    const sessionProjection = { start: vi.fn(async () => undefined), finish: vi.fn(async () => undefined) }
    const commandPort: TaskGraphCommandPort = {
      appendAndSchedule: vi.fn(async () => ({ status: "accepted" as const, revision: 1, nodes: [], readyTaskIds: [] })),
      readCurrent: vi.fn(async () => ({ revision: 0, nodes: [] })),
    }
    const selector = vi.fn(async () => ({ jobId: "job-1" }))
    const runtime = await createCanonicalTurnRuntime({ connect: vi.fn() } as never, {
      workerId: "worker-1", stateLoader: async () => state(), rootTaskStore: roots as never,
      selectedJobPreparationLoader: selector,
      taskGraphCommandPort: commandPort,
      taskGraphTemplates: { scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] } },
      modelRuntimeFactory, executionProjection, sessionProjection,
    })

    await expect(runtime.execute({ lease, signal: new AbortController().signal })).resolves.toEqual({
      status: "failed", summary: "selected_job_preparation_unavailable",
    })
    expect(selector).toHaveBeenCalledOnce()
    expect(modelRuntimeFactory).not.toHaveBeenCalled()
    expect(commandPort.appendAndSchedule).not.toHaveBeenCalled()
    expect(commandPort.readCurrent).not.toHaveBeenCalled()
    expect(roots.finish).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({ status: "failed", errorCode: "selected_job_preparation_unavailable", stepCount: 0, toolCallCount: 0 }),
    }))
    expect(executionProjection.finish).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({ status: "failed", errorCode: "selected_job_preparation_unavailable" }),
    }))
    expect(sessionProjection.finish).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({ status: "failed", errorCode: "selected_job_preparation_unavailable" }),
    }))
  })

  it("keeps ordinary Turns on the existing model path when no selected-job intent is present", async () => {
    const fixture = setup({
      selectedJobPreparationLoader: async () => undefined,
      taskGraphCommandPort: {
        appendAndSchedule: vi.fn(async () => ({ status: "accepted", revision: 1, nodes: [], readyTaskIds: [] })),
        readCurrent: vi.fn(async () => ({ revision: 0, nodes: [] })),
      },
    })

    await expect((await fixture.runtime).execute({ lease, signal: new AbortController().signal })).resolves.toMatchObject({ status: "completed" })
    expect(fixture.getModelCalls()).toBe(2)
    expect(fixture.tool.execute).toHaveBeenCalledOnce()
  })

  it("preserves Stop interruption when a selected-job Turn is already aborted", async () => {
    const selector = vi.fn(async () => ({ jobId: "job-1" }))
    const fixture = setup({ selectedJobPreparationLoader: selector })
    const controller = new AbortController()
    controller.abort(new InterruptRequestedError({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId }))

    await expect((await fixture.runtime).execute({ lease, signal: controller.signal })).resolves.toMatchObject({ status: "interrupted" })
    expect(selector).not.toHaveBeenCalled()
    expect(fixture.roots.finish).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({ status: "interrupted" }) }))
    expect(fixture.getModelCalls()).toBe(0)
  })

  it("preserves Stop interruption when the selected-job selector resolves after abort", async () => {
    let markStarted!: () => void
    let resolveSelection!: (selection: { jobId: string }) => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const pendingSelection = new Promise<{ jobId: string }>(resolve => { resolveSelection = resolve })
    const selector = vi.fn(() => {
      markStarted()
      return pendingSelection
    })
    const fixture = setup({ selectedJobPreparationLoader: selector })
    const controller = new AbortController()
    const execution = (await fixture.runtime).execute({ lease, signal: controller.signal })

    await started
    controller.abort(new InterruptRequestedError({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId }))
    resolveSelection({ jobId: "job-1" })

    await expect(execution).resolves.toMatchObject({ status: "interrupted" })
    expect(selector).toHaveBeenCalledOnce()
    expect(fixture.roots.finish).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({ status: "interrupted" }) }))
    expect(fixture.getModelCalls()).toBe(0)
  })

  it("advertises agent.plan through the configured model adapter when server gates are enabled", async () => {
    const requests: HarnessModelRequest[] = []
    const modelSnapshots: CanonicalTurnState["snapshot"][] = []
    let modelContext: StepContext | undefined
    const currentPlan: TaskGraphCurrentState = {
      revision: 1, nodes: [{
        key: "research", templateId: "scout", goal: "Find roles", successCriteria: ["Return links"], dependsOn: [],
        taskId: "child-1", status: "completed", readiness: "terminal", resultSummary: "Found two roles",
        resultProjection: {
          schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available",
          role: "scout", status: "completed", candidateCount: 1, evidenceCount: 1,
          candidates: [{ jobId: "job-42", source: "greenhouse", evidenceKinds: ["job"] }],
        },
        failureReason: "Jane Doe https://private.example/error",
      }],
    }
    const readCurrent = vi.fn(async (scope: TaskGraphReadScope): Promise<TaskGraphCurrentState> => {
      expect(scope).toMatchObject({ userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", turnLeaseOwner: "worker-1", turnLeaseVersion: 2, parentLeaseOwner: "worker-1", parentAttemptCount: 1 })
      return currentPlan
    })
    const taskGraphCommandPort: TaskGraphCommandPort = {
      appendAndSchedule: async () => ({ status: "accepted", revision: 1, nodes: [], readyTaskIds: [] }),
      readCurrent,
    }
    const planningFlags = resolveProductionAgentFlags({
      ENABLE_AGENT_TASK_GRAPH_PLANNING: "1", ENABLE_AGENT_CHILD_EXECUTION: "1", ENABLE_AGENT_WAIT_RESOLVER: "1",
    })
    const runtime = await createCanonicalTurnRuntime({ connect: vi.fn() } as never, {
      workerId: "worker-1", productionFlags: planningFlags, taskGraphCommandPort,
      taskGraphTemplates: { scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] } },
      selectedJobPreparationLoader: async () => undefined,
      stateLoader: async () => ({ ...state(), toolPolicySnapshot: {} }), rootTaskStore: rootStore() as never,
      turnEngineStoreFactory: () => store(),
      contextBuilderFactory: () => ({
        build: async request => {
          modelSnapshots.push(request.snapshot)
          const built = await contextBuilder().build(request)
          modelContext = built
          return built
        },
      }),
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

    await expect(runtime.execute({ lease, signal: new AbortController().signal })).resolves.toMatchObject({ status: "failed", summary: "evidence_missing" })
    const names = requests[0]?.tools.flatMap(tool => tool && typeof tool === "object" && "name" in tool && typeof tool.name === "string" ? [tool.name] : []) ?? []
    expect(names).toContain("agent.plan")
    expect(readCurrent).toHaveBeenCalledTimes(1)
    expect(modelSnapshots[0]?.toolObservations).toContainEqual({
      id: "task-graph-current",
      content: {
        kind: "task_graph_current",
        revision: 1,
        nodes: expect.arrayContaining([expect.objectContaining({
          key: "research",
          status: "completed",
          resultSummary: null,
          failureReason: null,
          resultProjection: expect.objectContaining({
            trust: "untrusted",
            availability: "available",
            candidates: [{ jobId: "job-42", source: "greenhouse", evidenceKinds: ["job"] }],
          }),
        })]),
      },
    })
    const observation = JSON.stringify(modelSnapshots[0]?.toolObservations)
    expect(observation).not.toContain("Found two roles")
    expect(observation).not.toContain("Jane Doe")
    expect(observation).not.toContain("private.example")
    expect(modelContext?.blocks.find(block => block.id === "task-graph-current")?.trust).toBe("external_untrusted")
  })

  it("filters restored and reconciled generic reads from selected-job resume context while preserving TaskGraph results", async () => {
    const privateSentinel = "PRIVATE_FORGED_JOB_READ_SENTINEL"
    const reconciledSentinel = "PRIVATE_RECONCILED_JOB_READ_SENTINEL"
    const requests: HarnessModelRequest[] = []
    const modelSnapshots: CanonicalTurnState["snapshot"][] = []
    const recoveredEvents: RuntimeEvent[] = []
    const recoveredItemUpdates: unknown[] = []
    let modelContext: StepContext | undefined
    const currentPlan: TaskGraphCurrentState = {
      revision: 7, nodes: [{
        key: "research", templateId: "scout", goal: "Find roles", successCriteria: ["Return links"], dependsOn: [],
        taskId: "child-1", status: "completed", readiness: "terminal", resultSummary: null,
        resultProjection: {
          schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available",
          role: "scout", status: "completed", candidateCount: 1, evidenceCount: 1,
          candidates: [{ jobId: "job-42", source: "greenhouse", evidenceKinds: ["job"] }],
        },
        failureReason: null,
      }],
    }
    const readCurrent = vi.fn(async (): Promise<TaskGraphCurrentState> => currentPlan)
    const taskGraphCommandPort: TaskGraphCommandPort = {
      appendAndSchedule: async () => ({ status: "accepted", revision: 1, nodes: [], readyTaskIds: [] }),
      readCurrent,
    }
    const resumedState: CanonicalTurnState = {
      ...state(),
      toolPolicySnapshot: {},
      resume: { nextOrdinal: 1, stepCount: 1, toolCallCount: 1, inputThroughSequence: 0n, consumedInputIds: [], usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } },
      pendingToolCalls: [{
        call: { id: "reconciled-job-read", name: "jobs.get", arguments: { jobId: "job-private" } },
        toolVersion: "1", stepId: "prior-step", callItem: { id: "persisted-reconciled-call", revision: 0 },
        durableResult: {
          id: "reconciled-job-read", toolName: "jobs.get", toolVersion: "1", status: "completed",
          output: { description: reconciledSentinel }, errorCode: null,
        },
      }],
      snapshot: {
        ...state().snapshot,
        toolObservations: [{
          id: "tool-result:forged-job-read",
          content: {
            toolCallId: "forged-job-read", toolName: "jobs.get", input: { jobId: "job-private" }, status: "completed",
            output: { description: privateSentinel }, errorCode: null,
          },
        }],
      },
    }
    const planningFlags = resolveProductionAgentFlags({
      ENABLE_AGENT_TASK_GRAPH_PLANNING: "1", ENABLE_AGENT_CHILD_EXECUTION: "1", ENABLE_AGENT_WAIT_RESOLVER: "1",
    })
    const runtime = await createCanonicalTurnRuntime({ connect: vi.fn() } as never, {
      workerId: "worker-1", productionFlags: planningFlags, taskGraphCommandPort,
      taskGraphTemplates: { scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] } },
      selectedJobPreparationLoader: async () => ({ jobId: "job-42" }),
      stateLoader: async () => resumedState,
      rootTaskStore: rootStore() as never,
      turnEngineStoreFactory: () => store(recoveredEvents, [], recoveredItemUpdates),
      contextBuilderFactory: () => ({
        build: async request => {
          modelSnapshots.push(request.snapshot)
          const built = await contextBuilder().build(request)
          modelContext = built
          return built
        },
      }),
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

    const modelMessages = JSON.stringify(requests[0]?.messages)
    expect(modelMessages).not.toContain(privateSentinel)
    expect(modelMessages).not.toContain(reconciledSentinel)
    expect(modelMessages).not.toContain("jobs.get")
    expect(modelMessages).toContain("job-42")
    expect(recoveredEvents.some(event => event.type === "tool_call.completed" && JSON.stringify(event.payload).includes("reconciled-job-read"))).toBe(true)
    expect(JSON.stringify(recoveredItemUpdates)).toContain(reconciledSentinel)
    const modelObservationIds = modelSnapshots[0]?.toolObservations.map(observation => observation.id) ?? []
    expect(modelObservationIds).not.toContain("tool-result:forged-job-read")
    expect(modelObservationIds).not.toContain("tool-result:reconciled-job-read")
    expect(modelObservationIds).toContain("task-graph-current")
    expect(modelSnapshots[0]?.toolObservations).toContainEqual(expect.objectContaining({
      id: "task-graph-current",
      content: expect.objectContaining({
        kind: "task_graph_current",
        nodes: expect.arrayContaining([expect.objectContaining({
          key: "research",
          resultProjection: expect.objectContaining({
            candidates: [{ jobId: "job-42", source: "greenhouse", evidenceKinds: ["job"] }],
          }),
        })]),
      }),
    }))
    expect(modelContext?.blocks.map(block => block.id)).not.toContain("tool-result:forged-job-read")
    expect(modelContext?.blocks.find(block => block.id === "task-graph-current")?.trust).toBe("external_untrusted")
    expect(readCurrent).toHaveBeenCalledTimes(2)
  })

  it("does not advertise agent.plan in the serving tool list with default production flags", async () => {
    const commandPort: TaskGraphCommandPort = {
      appendAndSchedule: vi.fn(async () => ({ status: "accepted" as const, revision: 1, nodes: [], readyTaskIds: [] })),
      readCurrent: vi.fn(async () => ({ revision: 0, nodes: [] })),
    }
    const flags = resolveProductionAgentFlags({})
    const names = await rootToolNames(flags.coordinationEnabled, ["read"], flags, {
      commandPort,
      templates: { scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] } },
    })

    expect(flags.taskGraphPlanningEnabled).toBe(false)
    expect(names).not.toContain("agent.plan")
    expect(commandPort.readCurrent).not.toHaveBeenCalled()
    expect(commandPort.appendAndSchedule).not.toHaveBeenCalled()
  })

  it("does not advertise agent.plan when the legacy cognitive-loop gate is the only opt-in", async () => {
    const commandPort: TaskGraphCommandPort = {
      appendAndSchedule: vi.fn(async () => ({ status: "accepted" as const, revision: 1, nodes: [], readyTaskIds: [] })),
      readCurrent: vi.fn(async () => ({ revision: 0, nodes: [] })),
    }
    const names = await rootToolNames(true, ["read"], resolveProductionAgentFlags({ ENABLE_AGENT_COGNITIVE_LOOP: "1" }), {
      commandPort,
      templates: { scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] } },
    })

    expect(names).not.toContain("agent.plan")
    expect(commandPort.readCurrent).not.toHaveBeenCalled()
  })

  it("advertises selected-job templates only when the persisted server selector is present", async () => {
    const commandPort: TaskGraphCommandPort = {
      appendAndSchedule: vi.fn(async () => ({ status: "accepted" as const, revision: 1, nodes: [], readyTaskIds: [] })),
      readCurrent: vi.fn(async () => ({ revision: 0, nodes: [] })),
    }
    const flags = resolveProductionAgentFlags({
      ENABLE_AGENT_TASK_GRAPH_PLANNING: "1", ENABLE_AGENT_CHILD_EXECUTION: "1", ENABLE_AGENT_WAIT_RESOLVER: "1",
    })
    const request = async (selection?: { readonly jobId: string }) => {
      const requests: HarnessModelRequest[] = []
      const runtime = await createCanonicalTurnRuntime({ connect: vi.fn() } as never, {
        workerId: "worker-1", productionFlags: flags, taskGraphCommandPort: commandPort,
        taskGraphTemplates: { scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] } },
        ...(selection ? { selectedJobPreparationLoader: async () => selection } : { selectedJobPreparationLoader: async () => undefined }),
        stateLoader: async () => ({ ...state(), toolPolicySnapshot: {} }), rootTaskStore: rootStore() as never,
        turnEngineStoreFactory: () => store(), contextBuilderFactory: () => contextBuilder(),
        modelRuntimeFactory: async () => ({ adapter: {
          ...model(() => []),
          async *stream(value: HarnessModelRequest) { requests.push(value); yield { type: "text_delta", text: "done" }; yield { type: "completed", finishReason: "stop" } },
        }, registry: {} as never, candidates: [] }),
        authorizeUsage: async () => ({ settle: async () => undefined }),
      })
      await runtime.execute({ lease, signal: new AbortController().signal })
      return requests[0]?.tools.find(tool => tool && typeof tool === "object" && "name" in tool && tool.name === "agent.plan")
    }
    const ordinaryPlanTool = await request()
    const selectedPlanTool = await request({ jobId: "job-52" })
    expect(ordinaryPlanTool && typeof ordinaryPlanTool === "object" && "description" in ordinaryPlanTool ? ordinaryPlanTool.description : "")
      .not.toContain("cover_letter_writer")
    expect(selectedPlanTool && typeof selectedPlanTool === "object" && "description" in selectedPlanTool ? selectedPlanTool.description : "")
      .toContain('"cover_letter_writer"')
    expect(selectedPlanTool && typeof selectedPlanTool === "object" && "description" in selectedPlanTool ? selectedPlanTool.description : "")
      .toContain('"artifact.version.read"')
  })

  it("fails closed before provider invocation when the scoped current graph read fails", async () => {
    const provider = vi.fn(async () => ({ adapter: model(() => []), registry: {} as never, candidates: [] }))
    const taskGraphCommandPort: TaskGraphCommandPort = {
      appendAndSchedule: async () => ({ status: "accepted", revision: 1, nodes: [], readyTaskIds: [] }),
      readCurrent: async () => { throw Object.assign(new Error("TaskGraph read unavailable"), { code: "task_graph_read_failed" }) },
    }
    const runtime = await createCanonicalTurnRuntime({ connect: vi.fn() } as never, {
      workerId: "worker-1", taskGraphCommandPort, taskGraphTemplates: { scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] } },
      productionFlags: { taskGraphPlanningEnabled: true, childExecutionEnabled: true, coordinationEnabled: true, consumeWaitOutcomes: false, canonicalAutomationEnabled: false },
      selectedJobPreparationLoader: async () => undefined,
      stateLoader: async () => ({ ...state(), toolPolicySnapshot: {} }), rootTaskStore: rootStore() as never,
      turnEngineStoreFactory: () => store(), contextBuilderFactory: () => contextBuilder(), modelRuntimeFactory: provider,
      authorizeUsage: async () => ({ settle: async () => undefined }),
    })

    await expect(runtime.execute({ lease, signal: new AbortController().signal })).rejects.toMatchObject({ code: "task_graph_read_failed" })
    expect(provider).not.toHaveBeenCalled()
  })

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

  it("restricts selected-job root tools to TaskGraph supervision and blocks forged execution", async () => {
    const selectedJobDenied = ["spawn_subagent", "agent.spawn", "agent.followup", "send_message", "agent.send", "interrupt_subagent", "agent.interrupt", "close_subagent", "agent.close", "wait_subagents"]
    const genericCoordination = [...selectedJobDenied, "agent.wait"]
    const retained = ["agent.plan", "agent.wait", "agent.list", "list_subagents"]
    const genericReads = ["jobs.search", "jobs.get", "persona.retrieve", "resume.get_base"]
    const selected = await taskGraphRootSurface(true)
    const generic = await taskGraphRootSurface(false)

    expect(selected.toolNames).not.toEqual(expect.arrayContaining(selectedJobDenied))
    expect(selected.allowedActions).not.toEqual(expect.arrayContaining(selectedJobDenied))
    expect(selected.toolNames).not.toEqual(expect.arrayContaining(genericReads))
    expect(selected.allowedActions).not.toEqual(expect.arrayContaining(genericReads))
    expect(selected.toolNames).toEqual(expect.arrayContaining(retained))
    expect(selected.allowedActions).toEqual(expect.arrayContaining(retained))
    expect(selected.route).not.toHaveBeenCalled()
    expect(JSON.stringify(selected.events)).not.toContain("forged-call")
    expect(JSON.stringify(selected.events)).not.toContain("PRIVATE_SOURCE_SENTINEL")

    expect(generic.toolNames).toEqual(expect.arrayContaining([...genericCoordination, ...retained]))
    expect(generic.toolNames).toEqual(expect.arrayContaining(genericReads))
    expect(generic.allowedActions).toEqual(expect.arrayContaining([...genericCoordination, ...retained]))
    expect(generic.allowedActions).toEqual(expect.arrayContaining(genericReads))
    expect(generic.route).toHaveBeenCalledOnce()

    const forgedRead = await taskGraphRootSurface(true, false, "jobs.get")
    expect(forgedRead.route).not.toHaveBeenCalled()
    expect(JSON.stringify(forgedRead.events)).not.toContain("PRIVATE_SOURCE_SENTINEL")

    const recovered = await taskGraphRootSurface(true, true)
    expect(recovered.route).not.toHaveBeenCalled()
    expect(JSON.stringify(recovered.events)).toContain("selected_job_root_tool_disabled")
    expect(JSON.stringify(recovered.events)).not.toContain("PRIVATE_SOURCE_SENTINEL")

    const recoveredRead = await taskGraphRootSurface(true, true, "agent.spawn", "jobs.get")
    expect(recoveredRead.route).not.toHaveBeenCalled()
    expect(JSON.stringify(recoveredRead.events)).not.toContain("PRIVATE_SOURCE_SENTINEL")
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
    await expect(fixture.runtime.then(runtime => runtime.execute({ lease, signal: new AbortController().signal })))
      .resolves.toMatchObject({ status: "completed" })
    expect(fixture.roots.checkCompletion).toHaveBeenCalledWith(expect.objectContaining({ rootTaskId: "root-1", lease }))
  })

  it("keeps generic Turns blocked while child tasks are pending", async () => {
    const roots = {
      ...rootStore(),
      checkCompletion: vi.fn(async () => ({ ok: false as const, blocker: "child_tasks_pending", feedback: "Child tasks are still running" })),
    }
    const fixture = setup({ rootTaskStore: roots })
    const runtime = await fixture.runtime

    await expect(runtime.execute({ lease, signal: new AbortController().signal })).resolves.toMatchObject({ status: "failed" })
    expect(roots.checkCompletion).toHaveBeenCalledOnce()
    expect(roots.finish).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({ errorCode: "business_precondition_failed" }) }))
  })

  it("requires a fresh exact selected-job draft review after the pending-child check", async () => {
    const artifactRef = {
      artifactId: "draft-1", version: 2, contentHash: `sha256:${"a".repeat(64)}`, sourceDigest: `sha256:${"b".repeat(64)}`,
    }
    const reviewedGraph: TaskGraphCurrentState = {
      revision: 2,
      nodes: [
        {
          key: "writer", templateId: "cover_letter_writer", goal: "Draft", successCriteria: ["Save"], dependsOn: [], taskId: "writer-1",
          status: "completed", readiness: "terminal", resultSummary: null, failureReason: null,
          resultProjection: { schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available", role: "writer", status: "completed", artifactRef },
        },
        {
          key: "reviewer", templateId: "cover_letter_reviewer", goal: "Review", successCriteria: ["Review"], dependsOn: ["writer"], taskId: "reviewer-1",
          status: "completed", readiness: "terminal", resultSummary: null, failureReason: null,
          resultProjection: {
            schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available", role: "reviewer", status: "completed",
            artifactRef, reviewStatus: "needs_revision", reviewHash: `sha256:${"c".repeat(64)}`,
          },
        },
      ],
    }
    const reads: TaskGraphCurrentState[] = [{ revision: 1, nodes: [] }, reviewedGraph]
    const taskGraphCommandPort: TaskGraphCommandPort = {
      appendAndSchedule: async () => ({ status: "accepted", revision: 1, nodes: [], readyTaskIds: [] }),
      readCurrent: vi.fn(async () => reads.shift() ?? reviewedGraph),
    }
    const roots = rootStore()
    const productionFlags = resolveProductionAgentFlags({
      ENABLE_AGENT_TASK_GRAPH_PLANNING: "1", ENABLE_AGENT_CHILD_EXECUTION: "1", ENABLE_AGENT_WAIT_RESOLVER: "1",
    })
    const runtime = await createCanonicalTurnRuntime({ connect: vi.fn() } as never, {
      workerId: "worker-1", productionFlags, taskGraphCommandPort,
      selectedJobPreparationLoader: async () => ({ jobId: "job-1" }),
      stateLoader: async () => ({ ...selectedJobState(), toolPolicySnapshot: {} }), rootTaskStore: roots as never,
      turnEngineStoreFactory: () => store(), contextBuilderFactory: () => contextBuilder(),
      modelRuntimeFactory: async () => ({ adapter: {
        ...model(() => []),
        async *stream() {
          yield { type: "text_delta", text: "The cover-letter draft is ready for review." }
          yield { type: "completed", finishReason: "stop" }
        },
      }, registry: {} as never, candidates: [] }),
      authorizeUsage: async () => ({ settle: async () => undefined }),
    })

    await expect(runtime.execute({ lease, signal: new AbortController().signal })).resolves.toMatchObject({ status: "completed" })
    expect(roots.checkCompletion).toHaveBeenCalledOnce()
    expect(taskGraphCommandPort.readCurrent).toHaveBeenCalledTimes(2)
    expect(taskGraphCommandPort.readCurrent).toHaveBeenLastCalledWith({
      userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: "root-1", parentTaskId: "root-1",
      turnLeaseOwner: lease.ownerId, turnLeaseVersion: lease.leaseVersion, parentLeaseOwner: lease.ownerId, parentAttemptCount: 1,
    })
  })

  it("keeps selected-job completion behind the pending-child check", async () => {
    const roots = {
      ...rootStore(),
      checkCompletion: vi.fn(async () => ({ ok: false as const, blocker: "child_tasks_pending", feedback: "Child tasks are still running" })),
    }
    const taskGraphCommandPort: TaskGraphCommandPort = {
      appendAndSchedule: async () => ({ status: "accepted", revision: 0, nodes: [], readyTaskIds: [] }),
      readCurrent: vi.fn(async () => ({ revision: 0, nodes: [] })),
    }
    const productionFlags = resolveProductionAgentFlags({
      ENABLE_AGENT_TASK_GRAPH_PLANNING: "1", ENABLE_AGENT_CHILD_EXECUTION: "1", ENABLE_AGENT_WAIT_RESOLVER: "1",
    })
    const runtime = await createCanonicalTurnRuntime({ connect: vi.fn() } as never, {
      workerId: "worker-1", productionFlags, taskGraphCommandPort,
      selectedJobPreparationLoader: async () => ({ jobId: "job-1" }),
      stateLoader: async () => ({ ...selectedJobState(), toolPolicySnapshot: {} }), rootTaskStore: roots as never,
      turnEngineStoreFactory: () => store(), contextBuilderFactory: () => contextBuilder(),
      modelRuntimeFactory: async () => ({ adapter: {
        ...model(() => []),
        async *stream() { yield { type: "text_delta", text: "Done." }; yield { type: "completed", finishReason: "stop" } },
      }, registry: {} as never, candidates: [] }),
      authorizeUsage: async () => ({ settle: async () => undefined }),
    })

    await expect(runtime.execute({ lease, signal: new AbortController().signal })).resolves.toMatchObject({ status: "failed" })
    expect(roots.checkCompletion).toHaveBeenCalledOnce()
    expect(taskGraphCommandPort.readCurrent).toHaveBeenCalledOnce()
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
