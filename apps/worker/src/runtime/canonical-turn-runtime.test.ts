import { describe, expect, it, vi } from "vitest"
import type { HarnessModelRequest, ModelAdapter, ModelStreamEvent } from "@jobcopilot/agent-model"
import type pg from "pg"
import type { StepContext } from "./context/step-context-builder.js"
import type { CanonicalTurnState } from "./canonical-turn-state.js"
import type { TurnEngineStore } from "./turns/turn-engine-types.js"
import { createCanonicalTurnRuntime } from "./canonical-turn-runtime.js"
import { loadCanonicalTurnState } from "./canonical-turn-state.js"
import { createPgRootTaskStore } from "./subagents/root-task-store.js"
import type { PlanProposal } from "./planning/goal-plan-contract.js"
import type { PersistedTaskGraphEvent } from "./planning/plan-task-graph-adapter.js"
import { PLAN_MAX_REVISIONS } from "./planning/goal-plan-contract.js"
import { fingerprintPlanProposal } from "./planning/plan-fingerprint.js"
import { PLAN_COMPLETION_FEEDBACK_EVENT_TYPE, planCompletionRecoveryCount } from "./planning/plan-completion-feedback.js"
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

function store(events: RuntimeEvent[] = [], batches: RuntimeEvent[][] = []): TurnEngineStore {
  return {
    startStep: async ({ stepId, ordinal }) => ({ id: stepId, ordinal }), updateStep: async () => undefined,
    createItem: async ({ itemId }) => ({ id: itemId, revision: 0 }), updateItem: async ({ itemId, expectedRevision }) => ({ id: itemId, revision: expectedRevision + 1 }),
    appendEvent: async ({ id, type, payload, correlationId, idempotencyKey, owner }) => { events.push({ id, type, payload, correlationId, idempotencyKey, owner }); return { id } }, recordFinalResponse: async () => undefined,
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
    registry: { list: () => [{ name: "jobs.search", version: "1" }, ...(includeCoordination ? coordinationDefinitions(missing) : [])], validateArguments: () => true as const },
    router: { execute },
  }
}

function plannerTools(includeCoordination = false) {
  const tool = tools(includeCoordination)
  return {
    ...tool,
    registry: {
      ...tool.registry,
      list: () => [{ name: "jobs.search", version: "1", risk: "read", domain: "jobs", capabilities: ["read"], requiredCapabilities: [] }, ...(includeCoordination ? coordinationDefinitions() : [])],
    },
  }
}

function throwingPlannerTools() {
  const tool = plannerTools()
  let calls = 0
  return {
    ...tool,
    registry: {
      ...tool.registry,
      list: () => {
        calls += 1
        if (calls === 2) throw new Error("registry unavailable")
        return tool.registry.list()
      },
    },
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

function durableRestartFixture() {
  type DurableEvent = { id: string; type: string; payload: unknown; idempotencyKey: string; userId: string; sessionId: string; turnId: string; sequence: string; taskId: string | null; itemId: string | null; correlationId: string; causationId: string | null }
  type DurableStep = { id: string; ordinal: number; attempt: number; inputThroughSequence: bigint; consumedInputIds: string[]; inputTokens: number; outputTokens: number; estimatedCostUsd: number }
  const feedbackPlan = "plan-1"
  const durable: { status: "queued" | "in_progress"; ownerId: string | null; leaseVersion: number; leaseStartedAt: Date | null; leaseExpiresAt: Date | null; events: DurableEvent[]; steps: DurableStep[] } = {
    status: "queued", ownerId: null, leaseVersion: 0, leaseStartedAt: null, leaseExpiresAt: null,
    events: [
      { id: "plan-revision-event", type: "plan.revision", payload: { planCallId: feedbackPlan, goalRevision: 1, planRevision: 1, basedOnPlanRevision: null }, idempotencyKey: "seed:plan-revision", userId: "user-1", sessionId: "session-1", turnId: "turn-1", sequence: "1", taskId: "root-1", itemId: null, correlationId: feedbackPlan, causationId: null },
      { id: "plan-result-event", type: "plan.observation", payload: { observationId: `plan-result:${feedbackPlan}:read`, content: { kind: "plan_command", localId: "read", commandKind: "tool_call", dependsOn: [], status: "completed", errorCode: null, output: { found: true } } }, idempotencyKey: "seed:plan-result", userId: "user-1", sessionId: "session-1", turnId: "turn-1", sequence: "2", taskId: "root-1", itemId: null, correlationId: "read", causationId: null },
      { id: "plan-control-event", type: "plan.observation", payload: { observationId: `plan-control:${feedbackPlan}:finish`, content: { kind: "plan_control", localId: "finish", status: "completion_proposed", dependsOn: ["missing"], completionCriteria: ["done"] } }, idempotencyKey: "seed:plan-control", userId: "user-1", sessionId: "session-1", turnId: "turn-1", sequence: "3", taskId: "root-1", itemId: null, correlationId: "finish", causationId: null },
    ],
    steps: [],
  }
  const items = [
    { type: "tool_call", content: { toolCallId: "evidence-call", toolName: "jobs.search", input: {}, status: "completed" } },
    { type: "tool_result", content: { toolCallId: "evidence-call", output: { found: true }, errorCode: null } },
  ]
  const requests: HarnessModelRequest[] = []
  let crashWindow = false
  let executionCount = 0
  let resolveFeedbackAppend!: () => void
  const feedbackAppendSettled = new Promise<void>(resolve => { resolveFeedbackAppend = resolve })
  const loadedStates: CanonicalTurnState[] = []
  const client = {
    query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 0 }
      if (sql.includes("WITH stale AS")) {
        if (durable.status !== "in_progress" || durable.ownerId !== null || !durable.leaseExpiresAt || durable.leaseExpiresAt > new Date(String(values?.[0]))) return { rows: [], rowCount: 0 }
        durable.status = "queued"; durable.ownerId = null; durable.leaseStartedAt = null; durable.leaseExpiresAt = null; durable.leaseVersion += 1
        return { rows: [{ id: "turn-1", sessionId: "session-1", leaseVersion: durable.leaseVersion }], rowCount: 1 }
      }
      if (sql.includes('SET "leaseExpiresAt" = LEAST')) {
        if (crashWindow) return { rows: [], rowCount: 0 }
        const renewedAt = new Date(String(values?.[5]))
        return { rows: [{ id: "turn-1", sessionId: "session-1", userId: "user-1", leaseOwnerId: durable.ownerId, leaseVersion: durable.leaseVersion, leaseStartedAt: durable.leaseStartedAt, leaseExpiresAt: new Date(renewedAt.getTime() + Number(values?.[4])) }], rowCount: 1 }
      }
      if (sql.includes(`SET "status" = 'in_progress'`)) {
        if (durable.status !== "queued") return { rows: [], rowCount: 0 }
        const started = new Date(String(values?.[3])); durable.status = "in_progress"; durable.ownerId = String(values?.[2]); durable.leaseStartedAt = started; durable.leaseExpiresAt = new Date(started.getTime() + Number(values?.[4])); durable.leaseVersion += 1
        return { rows: [{ id: "turn-1", sessionId: "session-1", userId: "user-1", leaseOwnerId: durable.ownerId, leaseVersion: durable.leaseVersion, leaseStartedAt: durable.leaseStartedAt, leaseExpiresAt: durable.leaseExpiresAt }], rowCount: 1 }
      }
      if (sql.includes('SET "status" = $5') && sql.includes('"leaseOwnerId" = NULL')) {
        durable.status = String(values?.[4]) as typeof durable.status; durable.ownerId = null; durable.leaseExpiresAt = null; return { rows: [], rowCount: 1 }
      }
      if (sql.includes('SET "leaseOwnerId" = NULL')) {
        durable.ownerId = null; durable.leaseExpiresAt = new Date(String(values?.[4])); return { rows: [], rowCount: 1 }
      }
      if (sql.includes('FROM "agent_turns"') && sql.includes('"input"')) {
        const ownerMatches = values?.[3] === durable.ownerId && Number(values?.[4]) === durable.leaseVersion
        return ownerMatches && durable.status === "in_progress" ? { rows: [{ id: "turn-1", sessionId: "session-1", userId: "user-1", status: durable.status, leaseOwnerId: durable.ownerId, leaseVersion: durable.leaseVersion, leaseExpiresAt: durable.leaseExpiresAt, input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: { provider: "fixture", model: "fixture" }, toolPolicySnapshot: {}, budgetSnapshot: { limits: { maxSteps: 4 } } }], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      if (sql.includes('MAX("ordinal")')) return { rows: [{ maxOrdinal: Math.max(...durable.steps.map(step => step.ordinal), -1) }], rowCount: 1 }
      if (sql.includes('FROM "agent_steps"')) return { rows: durable.steps, rowCount: durable.steps.length }
      if (sql.includes('FROM "agent_events"')) return { rows: durable.events, rowCount: durable.events.length }
      if (sql.includes('FROM "agent_items"')) return { rows: items, rowCount: items.length }
      if (sql.includes('FROM "agent_context_snapshots"') || sql.includes('FROM "agent_inputs"')) return { rows: [], rowCount: 0 }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool
  const append = async (input: Parameters<NonNullable<TurnEngineStore["appendEvent"]>>[0]) => {
    const existing = durable.events.find(event => event.idempotencyKey === input.idempotencyKey)
    if (existing) return { id: existing.id }
    const event: DurableEvent = { id: input.id, type: input.type, payload: input.payload, idempotencyKey: input.idempotencyKey, userId: "user-1", sessionId: "session-1", turnId: "turn-1", sequence: String(durable.events.length + 1), taskId: input.owner.taskId, itemId: input.itemId, correlationId: input.correlationId, causationId: input.causationId }
    durable.events.push(event)
    if (input.type === PLAN_COMPLETION_FEEDBACK_EVENT_TYPE && !crashWindow) {
      crashWindow = true
      await new Promise(resolve => setTimeout(resolve, 10))
      resolveFeedbackAppend()
    }
    return { id: event.id }
  }
  const store: TurnEngineStore = {
    startStep: async input => {
      const step = durable.steps.find(item => item.id === input.stepId)
      if (step) return { id: step.id, ordinal: step.ordinal }
      durable.steps.push({ id: input.stepId, ordinal: input.ordinal, attempt: input.attempt, inputThroughSequence: input.inputThroughSequence, consumedInputIds: [...input.consumedInputIds], inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 })
      return { id: input.stepId, ordinal: input.ordinal }
    },
    updateStep: async input => {
      const step = durable.steps.find(item => item.id === input.stepId)
      if (step) { step.inputTokens = input.inputTokens; step.outputTokens = input.outputTokens; step.estimatedCostUsd = input.estimatedCostUsd }
    },
    createItem: async input => ({ id: input.itemId, revision: 0 }),
    updateItem: async input => ({ id: input.itemId, revision: input.expectedRevision + 1 }),
    appendEvent: append,
    appendEvents: async inputs => Promise.all(inputs.map(append)),
    recordFinalResponse: async () => undefined,
  }
  const contextBuilderFactory = () => ({ build: async (input: { snapshot: CanonicalTurnState["snapshot"]; sessionId: string; turnId: string; stepId: string }): Promise<StepContext> => ({
    schemaVersion: "agent-harness.v2", sessionId: input.sessionId, turnId: input.turnId, stepId: input.stepId, inputThroughSequence: 0n, consumedInputIds: [],
    blocks: input.snapshot.toolObservations.map(item => ({ id: item.id, layer: "tool_observation", role: "data", trust: "external_untrusted", source: "tool_or_subagent", content: item.content as never })), canonicalJson: JSON.stringify(input.snapshot.toolObservations),
  }) })
  const createRuntime = () => createCanonicalTurnRuntime(pool, {
    workerId: "worker-1", planningEnabled: true, planningExecutionEnabled: true, planCompletionRecoveryLimit: 1,
    stateLoader: async (currentPool, currentLease) => { const loaded = await loadCanonicalTurnState(currentPool, currentLease); loadedStates.push(loaded); return loaded },
    rootTaskStore: rootStore() as never, toolRuntimeFactory: () => tools() as never, turnEngineStoreFactory: () => store, contextBuilderFactory,
    modelRuntimeFactory: async () => {
      const phase = executionCount++
      const adapter: ModelAdapter = { ...model(() => []), profile: { ...model(() => []).profile, continuationCursor: true }, async *stream(request) { requests.push(request); yield { type: "text_delta", text: phase === 0 ? "draft" : "resume" }; if (phase === 0) yield { type: "continuation", continuation: { cursor: "stale-provider-cursor" } }; yield { type: "completed", finishReason: "stop" } } }
      return { adapter, registry: {} as never, candidates: [] }
    },
    authorizeUsage: async () => ({ settle: async () => undefined }),
  })
  const payload = { turnId: "turn-1", sessionId: "session-1", ownerId: "worker-1" }
  return { durable, pool, createRuntime, feedbackAppendSettled, loadedStates, requests, payload, recoverAt: new Date("2026-09-07T00:02:00.000Z") }
}

async function rootToolNames(coordinationEnabled: boolean, planningEnabled = false, capabilities = ["read"], productionFlags?: ProductionAgentFlags): Promise<string[]> {
  const requests: HarnessModelRequest[] = []
  const runtime = await createCanonicalTurnRuntime({ connect: vi.fn() } as never, {
    workerId: "worker-1", coordinationEnabled, planningEnabled, ...(productionFlags ? { productionFlags } : {}), stateLoader: async () => ({ ...state(), toolPolicySnapshot: { capabilities } }),
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

async function runDefaultPlanBridge(planningExecutionEnabled: boolean, ownerId = "worker-1", events: RuntimeEvent[] = [], storeFactory: () => TurnEngineStore = () => store(events)) {
  const roots = rootStore()
  const calls: string[] = []
  let modelCalls = 0
  const proposal: PlanProposal = {
    schemaVersion: "agent-harness.plan.v1", basedOnGoalRevision: 1, basedOnPlanRevision: null,
    nodes: [
      { localId: "read", kind: "use_tool", objective: "Read jobs", inputRefs: [], dependsOn: [], successCriteria: ["done"], outputSchemaRef: null, toolName: "jobs.search" },
      { localId: "finish", kind: "propose_completion", objective: "Finish", inputRefs: [], dependsOn: ["read"], successCriteria: ["finish"], outputSchemaRef: null },
    ],
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
    workerId: ownerId, planningEnabled: true, planningExecutionEnabled, stateLoader: async () => state(), rootTaskStore: roots as never,
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
    toolRuntimeFactory: () => tool as never, turnEngineStoreFactory: storeFactory, contextBuilderFactory: () => contextBuilder(),
    authorizeUsage: async () => ({ settle: async () => undefined }),
  })
  const result = await runtime.execute({ lease: { ...lease, ownerId }, signal: new AbortController().signal })
  return { result, calls, events }
}

describe("createCanonicalTurnRuntime", () => {
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

  it("derives root planning capability only from the planning gate", async () => {
    const forged = await rootToolNames(false, false, ["read", "canPlan"])
    expect(forged).not.toContain("agent.plan.propose")
    const enabled = await rootToolNames(false, true)
    expect(enabled).toContain("agent.plan.propose")
  })

  it("uses one server activation contract for canonical runtime capabilities", async () => {
    const canonicalOnly = resolveProductionAgentFlags({ ENABLE_AGENT_CANONICAL_AUTOMATION: "1" })
    const canonicalOnlyTools = await rootToolNames(true, true, ["read"], canonicalOnly)
    expect(canonicalOnlyTools).not.toContain("agent.plan.propose")
    expect(canonicalOnlyTools).not.toContain("spawn_subagent")

    const partial = resolveProductionAgentFlags({ ENABLE_AGENT_CANONICAL_AUTOMATION: "1", ENABLE_AGENT_PLANNING: "1", ENABLE_AGENT_PLAN_EXECUTION: "1", ENABLE_AGENT_CHILD_EXECUTION: "1", ENABLE_AGENT_WAIT_RESOLVER: "1" })
    const partialTools = await rootToolNames(false, false, ["read"], partial)
    expect(partialTools).toContain("agent.plan.propose")
    expect(partialTools).toContain("spawn_subagent")

    const full = resolveProductionAgentFlags({ ENABLE_AGENT_COGNITIVE_LOOP: "1" })
    const fullTools = await rootToolNames(false, false, ["read"], full)
    expect(fullTools).toContain("agent.plan.propose")
    expect(fullTools).toContain("spawn_subagent")
  })

  it("uses the default plan bridge only when planning execution is explicitly enabled", async () => {
    const disabled = await runDefaultPlanBridge(false)
    expect(disabled.result.status).toBe("completed")
    expect(disabled.calls).toEqual(["agent.plan.propose"])
    const enabled = await runDefaultPlanBridge(true)
    expect(enabled.result.status).toBe("completed")
    expect(enabled.calls).toEqual(["agent.plan.propose", "jobs.search"])
    expect(enabled.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "plan.command", correlationId: "plan-call", idempotencyKey: expect.stringContaining("plan-command"), owner: expect.objectContaining({ taskId: "root-1" }) })]))
    expect(enabled.events).toEqual(expect.arrayContaining([expect.objectContaining({
      type: "plan.command", payload: expect.objectContaining({ content: expect.objectContaining({ kind: "plan_control", localId: "finish", status: "completion_proposed", dependsOn: ["read"] }) }),
    })]))
    const graphEvents = enabled.events.filter(event => event.type === "plan.task_graph")
    expect(graphEvents).toHaveLength(4)
    expect(graphEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ correlationId: "root-1:plan-call:1", idempotencyKey: expect.stringMatching(/^turn:plan-task-graph:[0-9a-f]{64}$/), owner: expect.objectContaining({ taskId: "root-1" }) }),
    ]))
    expect(graphEvents.every(event => typeof event.idempotencyKey === "string" && event.idempotencyKey.length <= 128)).toBe(true)
    expect(graphEvents.every(event => typeof event.payload === "object" && event.payload !== null && "runKey" in event.payload && event.payload.runKey === "root-1:plan-call:1")).toBe(true)
    expect(enabled.events.findIndex(event => event.type === "plan.task_graph")).toBeLessThan(enabled.events.findIndex(event => event.type === "plan.command"))
    const sharedEvents: RuntimeEvent[] = []
    await runDefaultPlanBridge(true, "worker-1", sharedEvents)
    const firstGraph = sharedEvents.filter(event => event.type === "plan.task_graph")
    await runDefaultPlanBridge(true, "worker-2", sharedEvents)
    const secondGraph = sharedEvents.filter(event => event.type === "plan.task_graph").slice(firstGraph.length)
    expect(secondGraph.map(event => [event.id, event.idempotencyKey, JSON.stringify(event.payload)])).toEqual(firstGraph.map(event => [event.id, event.idempotencyKey, JSON.stringify(event.payload)]))
  })

  it("appends each terminal graph event and matching receipt as one ordered batch", async () => {
    const events: RuntimeEvent[] = []
    const batches: RuntimeEvent[][] = []
    const enabled = await runDefaultPlanBridge(true, "worker-1", events, () => store(events, batches))
    const atomicBatches = batches.filter(batch => batch[0]?.type === "plan.task_graph")
    expect(enabled.result.status).toBe("completed")
    expect(atomicBatches.map(batch => batch.map(event => event.type))).toEqual([
      ["plan.task_graph", "plan.command"], ["plan.task_graph", "plan.command"],
    ])
    expect(atomicBatches.map(batch => batch.map(event => event.correlationId))).toEqual([
      ["root-1:plan-call:1", "plan-call"], ["root-1:plan-call:1", "plan-call"],
    ])
    expect(atomicBatches.map(batch => batch.map(event => event.idempotencyKey))).toEqual([
      [expect.stringMatching(/^turn:plan-task-graph:[0-9a-f]{64}$/), "turn:root-1:plan-command:plan-call:plan-result:plan-call:read"],
      [expect.stringMatching(/^turn:plan-task-graph:[0-9a-f]{64}$/), "turn:root-1:plan-command:plan-call:plan-control:plan-call:finish"],
    ])
    expect(atomicBatches[0]?.[0]?.payload).toMatchObject({ runKey: "root-1:plan-call:1", event: { eventId: "root-1:plan-call:1:read:complete" } })
    expect(atomicBatches[0]?.[1]?.payload).toMatchObject({ observationId: "plan-result:plan-call:read" })
    expect(atomicBatches[1]?.[0]?.payload).toMatchObject({ runKey: "root-1:plan-call:1", event: { eventId: "root-1:plan-call:1:finish:wait" } })
    expect(atomicBatches[1]?.[1]?.payload).toMatchObject({ observationId: "plan-control:plan-call:finish" })
    expect(atomicBatches.every(batch => batch.every(event => event.owner && typeof event.id === "string" && event.id.length <= 256))).toBe(true)
  })

  it("fails closed when atomic appendEvents is unavailable", async () => {
    const events: RuntimeEvent[] = []
    const singleOnly = () => {
      const base = store(events)
      const { appendEvents: _appendEvents, ...withoutBatch } = base
      return withoutBatch
    }
    const result = await runDefaultPlanBridge(true, "worker-1", events, singleOnly)
    expect(result.result.status).toBe("failed")
    expect(events.filter(event => event.type === "plan.task_graph").map(event => (event.payload as { event: { eventId: string } }).event.eventId)).toEqual(["root-1:plan-call:1:read:start"])
    expect(events.some(event => event.type === "plan.command")).toBe(false)
  })

  it("rejects canonical finals when completion evidence is missing or a dependency failed", async () => {
    const missing = setup({ planningEnabled: true, planningExecutionEnabled: true })
    await expect((await missing.runtime).execute({ lease, signal: new AbortController().signal })).resolves.toMatchObject({ status: "failed", summary: "final_unverified" })

    const failed = setup({
      planningEnabled: true, planningExecutionEnabled: true,
      stateLoader: async () => ({ ...state(), snapshot: {
        ...state().snapshot,
        toolObservations: [
          { id: "plan-result:plan:call:read", content: { kind: "plan_command", localId: "read", commandKind: "tool_call", dependsOn: [], status: "failed", errorCode: "denied" } },
          { id: "plan-control:plan:call:finish", content: { kind: "plan_control", localId: "finish", status: "completion_proposed", dependsOn: ["read"], completionCriteria: ["finish"] } },
        ],
      } }),
    })
    await expect((await failed.runtime).execute({ lease, signal: new AbortController().signal })).resolves.toMatchObject({ status: "failed", summary: "final_unverified" })
  })

  it("uses one in-memory completion recovery by default and accepts a zero server bound", async () => {
    const recovered = setup({ planningEnabled: true, planningExecutionEnabled: true })
    await (await recovered.runtime).execute({ lease, signal: new AbortController().signal })
    expect(recovered.getModelCalls()).toBe(3)

    const immediate = setup({ planningEnabled: true, planningExecutionEnabled: true, planCompletionRecoveryLimit: 0 })
    await (await immediate.runtime).execute({ lease, signal: new AbortController().signal })
    expect(immediate.getModelCalls()).toBe(2)

    const disabled = setup({ planningEnabled: true, planningExecutionEnabled: false, planCompletionRecoveryLimit: 2 })
    await (await disabled.runtime).execute({ lease, signal: new AbortController().signal })
    expect(disabled.getModelCalls()).toBe(2)
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

  it("derives only safe read-only planner roles from the live registry", async () => {
    const factory = vi.fn((input: { allowedRoles?: readonly string[] }) => {
      expect(input.allowedRoles).toEqual(["scout", "analyst", "reviewer", "auditor"])
      return async () => ({ observations: [] })
    })
    const enabled = setup({
      coordinationEnabled: true,
      planningEnabled: true,
      planningExecutionEnabled: true,
      toolRuntimeFactory: () => plannerTools(true) as never,
      planExecutionFactory: factory,
    })
    await (await enabled.runtime).execute({ lease, signal: new AbortController().signal })
    expect(factory).toHaveBeenCalledTimes(1)

    const disabledFactory = vi.fn(() => async () => ({ observations: [] }))
    const disabled = setup({ planningEnabled: false, planningExecutionEnabled: true, planExecutionFactory: disabledFactory })
    await (await disabled.runtime).execute({ lease, signal: new AbortController().signal })
    expect(disabledFactory).not.toHaveBeenCalled()
  })

  it("fails closed when the live planner role catalog is unavailable", async () => {
    const factory = vi.fn((input: { allowedRoles?: readonly string[] }) => {
      expect(input.allowedRoles).toEqual([])
      return async () => ({ observations: [] })
    })
    const fixture = setup({
      planningEnabled: true,
      planningExecutionEnabled: true,
      toolRuntimeFactory: () => throwingPlannerTools() as never,
      planExecutionFactory: factory,
    })
    await (await fixture.runtime).execute({ lease, signal: new AbortController().signal })
    expect(factory).toHaveBeenCalledTimes(1)
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

  it("passes server-hydrated task graph events only when present", async () => {
    const events: readonly PersistedTaskGraphEvent[] = [{ runKey: "root-1:proposal-1:1", event: { type: "start", nodeId: "read", eventId: "root-1:proposal-1:1:read:start" } }]
    const withHistoryFactory = vi.fn((input: { initialTaskGraphEvents?: readonly PersistedTaskGraphEvent[] }) => {
      expect(input.initialTaskGraphEvents).toBe(events)
      return async () => ({ observations: [] })
    })
    const withHistory = setup({ planningEnabled: true, planningExecutionEnabled: true, stateLoader: async () => ({ ...state(), taskGraphEvents: events }), planExecutionFactory: withHistoryFactory })
    await (await withHistory.runtime).execute({ lease, signal: new AbortController().signal })
    expect(withHistoryFactory).toHaveBeenCalledTimes(1)

    const withoutHistoryFactory = vi.fn((input: { initialTaskGraphEvents?: readonly PersistedTaskGraphEvent[] }) => {
      expect(input.initialTaskGraphEvents).toBeUndefined()
      return async () => ({ observations: [] })
    })
    const withoutHistory = setup({ planningEnabled: true, planningExecutionEnabled: true, planExecutionFactory: withoutHistoryFactory })
    await (await withoutHistory.runtime).execute({ lease, signal: new AbortController().signal })
    expect(withoutHistoryFactory).toHaveBeenCalledTimes(1)
  })

  it("derives plan action capabilities from the server coordination gate", async () => {
    const disabledFactory = vi.fn((input: { allowedPlanActions?: readonly string[] }) => {
      expect(input.allowedPlanActions).toEqual(["use_tool", "request_input", "propose_completion"])
      return async () => ({ observations: [] })
    })
    const disabled = setup({ coordinationEnabled: false, planningEnabled: true, planningExecutionEnabled: true, planExecutionFactory: disabledFactory })
    await (await disabled.runtime).execute({ lease, signal: new AbortController().signal })
    expect(disabledFactory).toHaveBeenCalledTimes(1)

    const enabledFactory = vi.fn((input: { allowedPlanActions?: readonly string[] }) => {
      expect(input.allowedPlanActions).toEqual(["use_tool", "delegate", "join", "request_input", "propose_completion"])
      return async () => ({ observations: [] })
    })
    const enabled = setup({ coordinationEnabled: true, planningEnabled: true, planningExecutionEnabled: true, planExecutionFactory: enabledFactory })
    await (await enabled.runtime).execute({ lease, signal: new AbortController().signal })
    expect(enabledFactory).toHaveBeenCalledTimes(1)
  })

  it("passes the server-hydrated goal semantics to the planning bridge", async () => {
    const factory = vi.fn((input: { goal: { constraints: readonly string[]; successCriteria: readonly string[]; knownFacts: readonly string[] } }) => {
      expect(input.goal).toMatchObject({ constraints: ["EU only"], successCriteria: ["ranked"], knownFacts: ["Dublin"] })
      return async () => ({ observations: [] })
    })
    const fixture = setup({
      planningEnabled: true,
      planningExecutionEnabled: true,
      stateLoader: async () => ({ ...state(), goalContract: { revision: 1, objective: "Find jobs", constraints: ["EU only"], successCriteria: ["ranked"], knownFacts: ["Dublin"], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "runtime:turn" } }),
      planExecutionFactory: factory,
    })
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

  it("resumes durable plan feedback across lease recovery without reusing provider state", async () => {
    const fixture = durableRestartFixture()
    const firstRuntime = await fixture.createRuntime()
    const first = await runTurnJob(
      { data: fixture.payload, attemptsMade: 0 },
      { pool: fixture.pool, execute: firstRuntime.execute, heartbeatMs: 1, now: () => new Date("2026-09-07T00:00:00.000Z") },
    )
    expect(first).toEqual({ status: "requeued", reasonCode: "lease_lost" })
    await fixture.feedbackAppendSettled
    expect(fixture.durable.events.filter(event => event.type === PLAN_COMPLETION_FEEDBACK_EVENT_TYPE)).toHaveLength(1)

    const reclaimed = await reclaimExpiredTurns(fixture.pool, fixture.recoverAt, 50)
    expect(reclaimed).toEqual([{ turnId: "turn-1", sessionId: "session-1", previousLeaseVersion: 1 }])

    const secondRuntime = await fixture.createRuntime()
    const second = await runTurnJob(
      { data: { ...fixture.payload, ownerId: "worker-2" }, attemptsMade: 1 },
      { pool: fixture.pool, execute: secondRuntime.execute, heartbeatMs: 999_999, now: () => fixture.recoverAt },
    )
    expect(second).toEqual({ status: "failed", summary: "final_unverified" })
    expect(fixture.loadedStates).toHaveLength(2)
    expect(planCompletionRecoveryCount(fixture.loadedStates[1]!.snapshot.toolObservations, "turn-1", "plan-1")).toBe(1)
    expect(fixture.loadedStates[1]!.resume).toMatchObject({ nextOrdinal: 1, stepCount: 1, toolCallCount: 1 })
    expect(fixture.requests).toHaveLength(2)
    expect(fixture.requests[1]?.continuation).toBeUndefined()
    expect(JSON.stringify(fixture.requests[1]?.messages)).toContain("plan_completion_feedback")
    expect(JSON.stringify(fixture.requests[1]?.messages)).toContain("plan-1")
    expect(fixture.durable.events.filter(event => event.type === PLAN_COMPLETION_FEEDBACK_EVENT_TYPE)).toHaveLength(1)
  })
})
