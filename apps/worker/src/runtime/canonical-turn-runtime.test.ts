import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("ioredis", () => ({ Redis: vi.fn().mockImplementation(() => ({ disconnect: vi.fn() })) }))
vi.mock("./selected-job-preparation.js", () => ({ loadSelectedJobPreparation: vi.fn(async () => undefined) }))
const selectedJobHistory = vi.hoisted(() => ({ load: vi.fn(async (..._args: unknown[]) => [] as unknown[]) }))
vi.mock("./context/selected-job-history-store.js", () => ({ createPgSelectedJobHistoryStore: () => selectedJobHistory }))
const selectedJobDirectHistory = vi.hoisted(() => ({ load: vi.fn(async (..._args: unknown[]) => [] as unknown[]) }))
vi.mock("./context/selected-job-history-direct-store.js", () => ({ createPgDirectSelectedJobHistoryStore: () => selectedJobDirectHistory }))
beforeEach(() => {
  selectedJobHistory.load.mockReset().mockImplementation(async () => [])
  selectedJobDirectHistory.load.mockReset().mockImplementation(async () => [])
})

import { redactSensitiveValue } from "@jobcopilot/shared"
import type { HarnessModelRequest, ModelAdapter, ModelStreamEvent } from "@jobcopilot/agent-model"
import type pg from "pg"
import { StepContextBuilder, type ContextOwnerFence, type StepContext } from "./context/step-context-builder.js"
import type { InputClaimStore, InputClaimTransaction, StoredAgentInput } from "./context/input-claim-store.js"
import type { CanonicalTurnState, CanonicalTurnStateLoadOptions } from "./canonical-turn-state.js"
import type { TurnEngineEvent, TurnEngineStore } from "./turns/turn-engine-types.js"
import { createCanonicalTurnRuntime, type CanonicalTurnRuntimeOptions } from "./canonical-turn-runtime.js"
import { TASK_GRAPH_RESULT_PROJECTION_SCHEMA, type TaskGraphCommandPort, type TaskGraphCurrentState, type TaskGraphNativeCommandInput, type TaskGraphReadScope, type TaskGraphScheduleInput, type TaskGraphTaskTemplate } from "./subagents/task-graph-command-port.js"
import { loadCanonicalTurnState } from "./canonical-turn-state.js"
import { projectSelectedJobMemory } from "./context/selected-job-memory.js"
import type { ValidatedSelectedJobHistoryOutcome } from "./context/selected-job-history.js"
import { TurnEngine } from "./turns/turn-engine.js"
import { createPgRootTaskStore } from "./subagents/root-task-store.js"
import { reclaimExpiredTurns } from "./turns/recovery-scanner.js"
import { runTurnJob } from "./turns/turn-queue.js"
import type { TurnLease } from "./turns/lease.js"
import { InterruptRequestedError } from "./interrupt/registry.js"
import { resolveProductionAgentFlags, type ProductionAgentFlags } from "./production-agent-flags.js"
import { nativeCoordinationReceipts } from "./canonical-turn-native-graph-context.js"
import { digestNativeVerificationValue } from "./subagents/native-verification-contract.js"
import type { NativeVerificationEnsureResult, NativeVerificationPort } from "./subagents/native-verification-port.js"
import type { NativeVerificationRuntime } from "./canonical-turn-native-verification-runtime.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "./planning/task-graph-verification.js"
import { buildCognitiveActionAgenda } from "./turns/cognitive-action-agenda.js"
import { buildCognitiveAgendaReceipt, COGNITIVE_AGENDA_EVENT_TYPE } from "./turns/cognitive-agenda-receipt.js"
import type { SteeringReconciliationOperation } from "./subagents/steering-reconciliation-contract.js"

const lease = {
  turnId: "turn-1", sessionId: "session-1", ownerId: "worker-1", userId: "user-1", leaseVersion: 2,
  leaseStartedAt: new Date("2026-09-07T00:00:00.000Z"), leaseExpiresAt: new Date("2026-09-07T00:01:00.000Z"),
}
type TurnEngineStoreFactory = NonNullable<CanonicalTurnRuntimeOptions["turnEngineStoreFactory"]>
const recoveredPlanHash = `sha256:${"a".repeat(64)}`
const canonicalJobId = "00000000-0000-4000-8000-000000000001"
type RuntimeEvent = { id?: string; type: string; payload: unknown; correlationId?: string; idempotencyKey?: string; owner?: unknown }

function state(overrides: Partial<CanonicalTurnState> = {}): CanonicalTurnState {
  return { scope: { userId: "user-1" }, goal: "Find jobs", modelProfileSnapshot: { provider: "fixture", model: "fixture" }, toolPolicySnapshot: {}, budgetSnapshot: { limits: { maxSteps: 4 } }, snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] }, ...overrides }
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
      ...(request.snapshot.taskGraphRevision === undefined ? {} : { taskGraphRevision: request.snapshot.taskGraphRevision }),
    }),
  }
}

function model(script: () => ModelStreamEvent[]): ModelAdapter {
  return { id: "fixture", profile: { provider: "fixture", model: "fixture", nativeTools: true, structuredOutput: true, streaming: true, continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false, supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false, supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: null, costClass: "low" }, async *stream() { yield* script() } }
}

function rootStore() {
  return { ensure: vi.fn(async () => ({ id: "root-1", attemptCount: 1 } as never)), checkCompletion: vi.fn(async () => ({ ok: true as const })), finish: vi.fn(async () => undefined) }
}

/** Gives planning-enabled runtime fakes a valid, empty reconciliation ledger instead of bypassing its SQL guard. */
function emptyPlanningLedgerPool(base?: Pick<pg.Pool, "connect"> & Partial<Pick<pg.Pool, "query">>): pg.Pool {
  const connect = vi.fn(async () => {
    const downstream = base ? await base.connect() : undefined
    let scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", attempt: 1 }
    const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes('SELECT "id" FROM "agent_sessions"')) return { rows: [{ id: values[0] }], rowCount: 1 }
      if (sql.includes('SELECT session."id" FROM "agent_sessions"')) return { rows: [{ id: values[0] }], rowCount: 1 }
      if (sql.includes('SELECT "id" FROM "agent_turns"') && !sql.includes('SELECT turn."input"')) return { rows: [{ id: values[0] }], rowCount: 1 }
      if (sql.includes('SELECT task.*, session."userId" AS "userId" FROM "sub_agent_tasks"')) {
        scope = { userId: String(values[4]), sessionId: String(values[1]), turnId: String(values[2]), rootTaskId: String(values[3]), attempt: Number(values[6]) }
        return { rows: [{ id: values[0], userId: values[4], status: "running", allowedActions: ["agent.plan"] }], rowCount: 1 }
      }
      if (sql.includes("WITH wall_clock AS MATERIALIZED")) return { rows: [{ turnLeaseValid: true, parentLeaseValid: true }], rowCount: 1 }
      if (sql.includes('SELECT turn."input" FROM "agent_turns"')) return { rows: [{ input: {} }], rowCount: 1 }
      if (sql.includes('FROM "agent_inputs" WHERE "sessionId"')) return { rows: [], rowCount: 0 }
      if (sql.includes('SELECT item."revision" FROM "agent_items" AS item')) return { rows: [], rowCount: 0 }
      if (sql.includes('event."type" = $3 ORDER BY event."sequence" ASC')) return { rows: [], rowCount: 0 }
      if (sql.includes('SELECT "id" FROM "agent_steps"')) return { rows: [{ id: values[0] }], rowCount: 1 }
      if (sql.includes('SELECT "id", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds"')) {
        return { rows: [{ id: values[0], taskId: scope.rootTaskId, ordinal: 0, attempt: scope.attempt, status: "streaming", inputThroughSequence: 0n, consumedInputIds: [] }], rowCount: 1 }
      }
      if (sql.includes('event."type" = \'cognitive.agenda\'')) {
        const stepId = String(values[3])
        const context = { schemaVersion: "agent-harness.v2" as const, sessionId: scope.sessionId, turnId: scope.turnId, stepId,
          inputThroughSequence: 0n, consumedInputIds: [], blocks: [], canonicalJson: "{}", taskGraphRevision: 0 }
        const payload = buildCognitiveAgendaReceipt({ sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.rootTaskId, stepId,
          inputThroughSequence: 0n, consumedInputIds: [], agenda: buildCognitiveActionAgenda(context) })
        return { rows: [{ actor: "orchestrator", itemId: null, taskId: scope.rootTaskId, correlationId: stepId, payload }], rowCount: 1 }
      }
      if (downstream) return downstream.query(sql, values as never)
      return { rows: [], rowCount: 0 }
    })
    return { query, release: () => downstream?.release() } as unknown as pg.PoolClient
  })
  return { connect, query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
    if (base?.query) return base.query(sql, values as never)
    return { rows: [], rowCount: 0 }
  }) } as unknown as pg.Pool
}

function nativeVerificationRuntime(childStatus: "passed" | "failed" = "passed"): NativeVerificationRuntime {
  const port: NativeVerificationPort = {
    ensureChildren: async (): Promise<NativeVerificationEnsureResult> => ({ status: childStatus, controlTaskIds: [], pendingControlTaskIds: [], pendingTaskIds: [], feedback: [] }),
    ensureRootGoal: async ({ candidateText }): Promise<NativeVerificationEnsureResult> => ({ status: "passed", controlTaskIds: ["control-1"], pendingControlTaskIds: [], pendingTaskIds: [], feedback: [], rootGoalWitness: {
      controlTaskId: "control-1", controlOperationId: "operation-1", currentControlAttempt: 1,
      candidateDigest: digestNativeVerificationValue(candidateText), childBindingSetDigest: "a".repeat(64), goalDigest: "b".repeat(64),
      criteriaDigest: "c".repeat(64), evidencePacketDigest: "d".repeat(64), reportDigest: "e".repeat(64),
    } }),
    readRecoverableGoal: async () => null,
  }
  return { port, readTerminalProof: async () => true }
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
  const jobs = [{ id: canonicalJobId, company: "Example", role: "Engineer", location: "Dublin", status: "open", score: 8, url: "https://jobs.example/1", source: "fixture", salary: null, description: "Role contact candidate@example.test with key sk-secretvalue123", keywords: null, createdAt: new Date("2026-09-07T00:00:00.000Z"), updatedAt: new Date("2026-09-07T00:00:00.000Z") }]
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
      if (sql.includes('SELECT active_turn."createdAt"')) return { rows: [{ createdAt: new Date("2026-09-07T00:00:00.000Z") }], rowCount: 1 }
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
  interactiveDiscovery = false,
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
    taskGraphTemplates: interactiveDiscovery ? {
      scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] },
      analyst: { role: "analyst", taskType: "job_analysis", allowedActions: ["jobs.get"] },
      writer: { role: "writer", taskType: "cover_letter_draft", allowedActions: ["cover_letter.draft"] },
      reviewer: { role: "reviewer", taskType: "cover_letter_review", allowedActions: ["artifact.review"] },
    } : { scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] } },
    selectedJobPreparationLoader: async () => selectedJob ? { jobId: "job-1" } : undefined,
    stateLoader: async () => ({
      ...state(), toolPolicySnapshot: { capabilities: ["read"] },
      ...(interactiveDiscovery ? { intent: { kind: "interactive_discovery_shortlist" as const, version: 1 as const } } : {}),
      ...(recoverHiddenMutation ? {
        pendingToolCalls: [{ call: { id: "persisted-hidden-call", name: recoveredToolName, arguments: recoveredToolName === "jobs.get" ? { jobId: "job-other" } : {} }, toolVersion: "1", stepId: "prior-step", callItem: { id: "persisted-call-item", revision: 0 } }],
        resume: { nextOrdinal: 1, stepCount: 1, toolCallCount: 1, inputThroughSequence: 0n, consumedInputIds: [], usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } },
      } : {}),
    }),
    rootTaskStore: roots as never, turnEngineStoreFactory: () => store(events), contextBuilderFactory: () => contextBuilder(),
    ...(interactiveDiscovery ? { interactiveDiscoveryShortlistLoader: async () => undefined } : {}),
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
  return { toolNames, allowedActions, route, events, roots, requests }
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

  it("reloads compacted context before the first request without consuming waits twice", async () => {
    const initial = state({
      contextSnapshotPinned: false,
      snapshot: {
        ...state().snapshot,
        goal: { id: "turn-goal:turn-1", content: "Find jobs" },
        toolObservations: [
          { id: "stale-search", content: { toolName: "jobs.search" } },
          { id: "wait-result:wait-1", content: { toolName: "agent.wait", output: { status: "ready" } } },
          { id: "task-graph-current", content: { kind: "task_graph_current", revision: 1 } },
        ],
      },
    })
    const refreshed = state({
      contextSnapshotPinned: false,
      snapshot: {
        ...state().snapshot,
        goal: { id: "turn-goal:turn-1", content: "stale snapshot goal" },
        steerHistory: [{ id: "cursor-tail:9", content: "recent turn history" }],
        businessRefs: [{ id: "selected-job", kind: "job", ownerId: "user-1", label: "Selected role" }],
        toolObservations: [
          { id: "new-search", content: { toolName: "jobs.search" } },
          { id: "task-graph-current", content: { kind: "task_graph_current", revision: 2 } },
        ],
      },
    })
    let loadCount = 0
    const loadOptions: CanonicalTurnStateLoadOptions[] = []
    const stateLoader = vi.fn(async (_pool: unknown, _lease: TurnLease, _now: Date | undefined, options?: CanonicalTurnStateLoadOptions) => {
      loadOptions.push(options ?? {})
      loadCount += 1
      return loadCount === 1 ? initial : refreshed
    })
    const observedSnapshots: CanonicalTurnState["snapshot"][] = []
    const modelRequests: HarnessModelRequest[] = []
    const adapter = {
      ...model(() => []),
      async *stream(request: HarnessModelRequest): AsyncIterable<ModelStreamEvent> {
        modelRequests.push(request)
        yield { type: "text_delta", text: "done" }
        yield { type: "completed", finishReason: "stop" }
      },
    }
    const graph = {
      appendAndSchedule: vi.fn(async () => ({ status: "accepted" as const, revision: 1, nodes: [], readyTaskIds: [] })),
      readCurrent: vi.fn(async () => ({ revision: 9, nodes: [] })),
    }
    const runtimeTools = tools(true)
    const runner = vi.fn(async () => ({ status: "compacted" as const }))
    const runtime = await createCanonicalTurnRuntime(emptyPlanningLedgerPool(), {
      workerId: "worker-1",
      productionFlags: resolveProductionAgentFlags({
        ENABLE_AGENT_TASK_GRAPH_PLANNING: "1", ENABLE_AGENT_CHILD_EXECUTION: "1", ENABLE_AGENT_WAIT_RESOLVER: "1",
        ENABLE_AGENT_TURN_BOUNDARY_COMPACTION: "1",
      }),
      stateLoader,
      selectedJobPreparationLoader: async () => ({ jobId: "job-1" }),
      taskGraphCommandPort: graph,
      taskGraphTemplates: { scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] } },
      rootTaskStore: rootStore() as never,
      toolRuntimeFactory: () => ({ ...runtimeTools, registry: { ...runtimeTools.registry, register: () => undefined } }) as never,
      turnEngineStoreFactory: () => store(),
      contextBuilderFactory: () => ({ build: async request => {
        observedSnapshots.push(request.snapshot)
        return await contextBuilder().build(request)
      } }),
      modelRuntimeFactory: async () => ({ adapter, registry: {} as never, candidates: [] }),
      authorizeUsage: async () => ({ settle: async () => undefined }),
      turnBoundaryCompactionRunner: runner,
    })

    await expect(runtime.execute({ lease, signal: new AbortController().signal })).resolves.toMatchObject({ status: "failed" })
    expect(runner).toHaveBeenCalledOnce()
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ taskGraphCommandPort: graph }))
    expect(loadOptions).toEqual([{ consumeWaitOutcomes: true }, { consumeWaitOutcomes: false }])
    expect(graph.readCurrent).toHaveBeenCalledTimes(4)
    expect(observedSnapshots[0]?.goal).toEqual(initial.snapshot.goal)
    expect(observedSnapshots[0]?.steerHistory).toContainEqual({ id: "cursor-tail:9", content: "recent turn history" })
    expect(observedSnapshots[0]?.businessRefs).toEqual(refreshed.snapshot.businessRefs)
    expect(observedSnapshots[0]?.toolObservations).toEqual([
      { id: "wait-result:wait-1", content: { toolName: "agent.wait", output: { status: "ready" } } },
      { id: "task-graph-current", content: { kind: "task_graph_current", revision: 9, nodes: [] } },
    ])
    expect(modelRequests).toHaveLength(1)
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
    const runtime = await createCanonicalTurnRuntime(emptyPlanningLedgerPool(), {
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
    expect(readCurrent).toHaveBeenCalledTimes(2)
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

  it("revises through the registered planner after question recovery while carrying untrusted root background", async () => {
    const originalText = "Original request: find English-first, remote engineering roles in Germany and cite each employer source."
    const steerParts = [
      `Prioritize fully remote teams and retain these constraints: ${"Do not include employers requiring relocation. ".repeat(220)}`,
      "Prefer roles with explicit English-language requirements and cite each employer source.",
    ]
    const questionText = "Which country should I prioritize?"
    const answerText = "Germany, please."
    const originalInput: StoredAgentInput = {
      id: "original-root-input", sessionId: lease.sessionId, targetTurnId: lease.turnId, userId: lease.userId,
      clientMessageId: "original-client-message", delivery: "follow_up", status: "consumed",
      content: [{ type: "text", text: originalText }], acceptedSequence: 1n,
      consumedByStepId: "original-step", consumedAt: new Date("2026-09-07T00:00:00.000Z"), createdAt: new Date("2026-09-07T00:00:00.000Z"),
    }
    const steer: StoredAgentInput = {
      id: "resumed-steer-input", sessionId: lease.sessionId, targetTurnId: lease.turnId, userId: lease.userId,
      clientMessageId: "steer-client-message", delivery: "steer", status: "consumed",
      content: steerParts.map(text => ({ type: "text" as const, text })), acceptedSequence: 3n, consumedByStepId: "question-step-0", consumedAt: new Date("2026-09-07T00:00:01.000Z"),
      createdAt: new Date("2026-09-07T00:00:01.000Z"),
    }
    let cursor = 3n, steerReconciled = false
    const checkpoints: Array<{ inputThroughSequence: bigint; consumedInputIds: readonly string[] }> = []
    const transaction: InputClaimTransaction = {
      getCheckpoint: async () => ({ inputThroughSequence: cursor, consumedInputIds: [] }),
      claimInputs: async () => ({ inputs: [], newlyClaimedInputIds: [] }),
      persistCheckpoint: async request => { cursor = request.checkpoint.inputThroughSequence; checkpoints.push(request.checkpoint) },
      loadRootInputContext: async request => request.inputId === originalInput.id ? originalInput : null,
      loadUnresolvedSteeringInputs: async () => steerReconciled ? [] : [steer],
    }
    const inputStore: InputClaimStore = { scope: { userId: lease.userId }, withTransaction: async work => work(transaction) }
    const ownerFence: ContextOwnerFence = {
      assertReferenceOwned: async () => undefined,
      assertAttachmentOwned: async reference => ({ attachmentId: reference.attachmentId }),
    }
    const contexts: StepContext[] = [], requests: HarnessModelRequest[] = [], events: RuntimeEvent[] = []
    const builder = new StepContextBuilder(inputStore, ownerFence, () => new Date("2026-09-07T00:00:02.000Z"), {
      userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: "root-1", parentTaskId: "root-1",
      turnLeaseOwner: lease.ownerId, turnLeaseVersion: lease.leaseVersion, parentLeaseOwner: lease.ownerId, parentAttemptCount: 1, rootInputId: originalInput.id,
    })
    const rootQuestionId = "question-wait-1"
    const latestStepQuestionText = "Which country should I prioritize for this step?"
    const latestStepAnswerText = "Germany, for this step."
    const laterAnsweredOlderQuestionText = "Which city should I prioritize?"
    const laterAnsweredOlderAnswerText = "Berlin, please."
    const planningSummary = { observedPlanRevision: 0, graphRevisionAtAsk: 1, pendingSteerCount: 1,
      unconsumedSteerCount: 1, inputThroughSequence: "3" }
    const questionStore = {
      ...store(events),
      stageQuestionUsage: vi.fn(async () => undefined),
      cancelPausedQuestion: vi.fn(async () => "cancelled" as const),
      waitForQuestion: vi.fn(async () => ({ status: "waiting_for_user" as const, disposition: "created" as const,
        waitId: rootQuestionId, itemId: "question-item-1", turnId: lease.turnId, toolCallId: "question-call-1", nextTurnRevision: 4 })),
      readPendingQuestion: vi.fn(async () => ({ status: "answered" as const, stepId: "question-step-0", toolCallId: "question-call-1",
        waitId: rootQuestionId, itemId: "question-item-1", turnId: lease.turnId })),
    }
    const node = {
      key: "research", templateId: "scout", goal: "Find sourced roles", successCriteria: ["Return employer links"], dependsOn: [],
      taskId: "planned-child", status: "queued" as const, readiness: "ready" as const, resultSummary: null, failureReason: null,
    }
    let planRevision = 0
    const appendAndScheduleWithReconciliation = vi.fn(async (_input: TaskGraphScheduleInput, _operation: SteeringReconciliationOperation) => {
      planRevision = 1
      steerReconciled = true
      return { status: "accepted" as const, revision: 1, nodes: [{ key: node.key, taskId: node.taskId, status: "queued" as const }], readyTaskIds: [node.taskId] }
    })
    const taskGraphCommandPort: TaskGraphCommandPort = {
      appendAndSchedule: vi.fn(async () => { throw new Error("raw planning command was used") }),
      appendAndScheduleWithReconciliation,
      reconcileSteering: vi.fn(async () => ({ decision: "keep" as const, revision: planRevision, reconciledInputCount: 0 })),
      readCurrent: vi.fn(async (_scope: TaskGraphReadScope): Promise<TaskGraphCurrentState> => ({ revision: planRevision, nodes: planRevision === 0 ? [] : [node] })),
    }
    const resumed = state({
      rootInputId: originalInput.id,
      resume: { nextOrdinal: 1, stepCount: 1, toolCallCount: 1, inputThroughSequence: 3n, consumedInputIds: ["previous-step-steer"], usage: { inputTokens: 12, outputTokens: 4, estimatedCostUsd: 0.001 } },
      snapshot: {
        ...state().snapshot, goal: { id: "canonical-goal", content: "Find software engineering roles." },
        steerHistory: [
          { id: "agent-question:question-item-2:question", content: { role: "assistant", type: "question", question: latestStepQuestionText, options: [{ label: "Germany", value: "de" }] } },
          { id: "agent-question:question-item-2:answer", content: { role: "user", type: "answer", questionId: "wait-2", text: latestStepAnswerText } },
          { id: "agent-question:question-item-1:question", content: { role: "assistant", type: "question", question: questionText, options: [{ label: "Germany", value: "de" }] } },
          { id: "agent-question:question-item-1:answer", content: { role: "user", type: "answer", questionId: rootQuestionId, text: answerText } },
          { id: "agent-question:question-item-3:question", content: { role: "assistant", type: "question", question: laterAnsweredOlderQuestionText, options: [{ label: "Berlin", value: "berlin" }] } },
          { id: "agent-question:question-item-3:answer", content: { role: "user", type: "answer", questionId: "wait-3", text: laterAnsweredOlderAnswerText } },
        ],
        planningClarifications: [planningSummary],
        planningClarificationHistoryPair: {
          questionEntryId: "agent-question:question-item-2:question",
          answerEntryId: "agent-question:question-item-2:answer",
        },
      },
    })
    const proposal = {
      expectedRevision: 0,
      nodes: [{ key: node.key, templateId: "scout", goal: node.goal, successCriteria: [...node.successCriteria], dependsOn: [],
        verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }] } }],
    }
    const modelAdapter: ModelAdapter = {
      ...model(() => []),
      async *stream(request: HarnessModelRequest) {
        requests.push(request)
        if (requests.length === 1) {
          yield { type: "tool_call_completed", callId: "plan-after-answer", name: "agent.plan", arguments: proposal }
          yield { type: "completed", finishReason: "tool_calls" }
        } else {
          yield { type: "text_delta", text: "I found sourced roles." }
          yield { type: "completed", finishReason: "stop" }
        }
      },
    }
    const runtime = await createCanonicalTurnRuntime(emptyPlanningLedgerPool(), {
      workerId: "worker-1", productionFlags: resolveProductionAgentFlags({
        ENABLE_AGENT_TASK_GRAPH_PLANNING: "1", ENABLE_AGENT_CHILD_EXECUTION: "1", ENABLE_AGENT_WAIT_RESOLVER: "1",
      }), nativeQuestionWaitEnabled: true, taskGraphCommandPort,
      taskGraphTemplates: { scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] } },
      selectedJobPreparationLoader: async () => undefined, stateLoader: async () => resumed, rootTaskStore: rootStore() as never,
      nativeVerificationFactory: () => nativeVerificationRuntime(), turnEngineStoreFactory: () => questionStore,
      contextBuilderFactory: () => ({ build: async request => { const context = await builder.build(request); contexts.push(context); return context } }),
      modelRuntimeFactory: async () => ({ adapter: modelAdapter, registry: {} as never, candidates: [] }),
      authorizeUsage: async () => ({ settle: async () => undefined }),
    })

    const executionResult = await runtime.execute({ lease, signal: new AbortController().signal })
    expect(["completed", "failed"]).toContain(executionResult.status)
    expect(questionStore.readPendingQuestion).toHaveBeenCalledOnce()
    expect(appendAndScheduleWithReconciliation).toHaveBeenCalledOnce()
    const [scheduled, operation] = appendAndScheduleWithReconciliation.mock.calls[0]!
    expect(scheduled.proposal.expectedRevision).toBe(0)
    expect(operation).toMatchObject({ decision: "revise", expectedRevision: 0, callId: "plan-after-answer", rootInputId: originalInput.id })
    expect(operation.scope.stepId).toBe(contexts[0]?.stepId)
    const tools = requests[0]?.tools.flatMap(tool => tool && typeof tool === "object" && "name" in tool && typeof tool.name === "string" ? [tool.name] : []) ?? []
    expect(tools).toEqual(expect.arrayContaining(["agent.plan", "agent.reconcile", "agent.ask_user"]))
    expect(contexts).toHaveLength(2)
    expect(contexts.map(context => context.taskGraphRevision)).toEqual([0, 1])
    for (const context of contexts) {
      const reference = context.blocks.find(block => block.layer === "pending_input" && block.content !== null && typeof block.content === "object" && !Array.isArray(block.content) && block.content.inputId === originalInput.id)
      expect(reference).toMatchObject({ trust: "external_untrusted", content: { inputId: originalInput.id, text: originalText } })
      expect(context.blocks.some(block => block.layer === "steer_history" && JSON.stringify(block.content).includes(questionText))).toBe(true)
      expect(context.blocks.some(block => block.layer === "steer_history" && JSON.stringify(block.content).includes(answerText))).toBe(true)
      expect(context.blocks.some(block => block.layer === "steer_history" && JSON.stringify(block.content).includes(latestStepQuestionText))).toBe(true)
      expect(context.blocks).toContainEqual({ id: "planning-clarification:latest-answered-question", layer: "steer_history", role: "data",
        trust: "internal_record", source: "native_question_recovery", content: planningSummary })
      expect(context.planningClarifications).toEqual([planningSummary])
    }
    expect(contexts[0]?.blocks.filter(block => block.layer === "pending_input" && JSON.stringify(block.content).includes("resumed-steer-input"))).toHaveLength(2)
    expect(contexts[0]?.blocks.some(block => block.layer === "pending_input" && JSON.stringify(block.content).includes(steerParts[0]!))).toBe(true)
    expect(contexts[0]?.blocks.some(block => block.layer === "pending_input" && JSON.stringify(block.content).includes(steerParts[1]!))).toBe(true)
    expect(contexts[1]?.blocks.some(block => block.layer === "pending_input" && JSON.stringify(block.content).includes("resumed-steer-input"))).toBe(false)
    expect(contexts.map(context => context.inputThroughSequence)).toEqual([3n, 3n])
    expect(contexts.map(context => context.consumedInputIds)).toEqual([[], []])
    const requestMessages = requests.map(request => JSON.stringify(request.messages))
    expect(requestMessages).toHaveLength(2)
    for (const messages of requestMessages) {
      expect(messages).toContain(originalText)
      expect(messages).toContain(questionText)
      expect(messages).toContain(answerText)
      expect(messages).toContain(latestStepQuestionText)
      expect(messages).toContain(latestStepAnswerText)
      expect(messages).toContain(laterAnsweredOlderQuestionText)
      expect(messages).toContain(laterAnsweredOlderAnswerText)
    }
    const firstRequestText = requests[0]!.messages.map(message => message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n"))
    const selectedQuestionIndex = firstRequestText.findIndex(text => text.includes(latestStepQuestionText))
    const selectedAnswerIndex = firstRequestText.findIndex(text => text.includes(latestStepAnswerText))
    const summaryIndex = firstRequestText.findIndex(text => text.includes('"graphRevisionAtAsk":1'))
    const laterAnsweredQuestionIndex = firstRequestText.findIndex(text => text.includes(laterAnsweredOlderQuestionText))
    expect(selectedAnswerIndex).toBe(selectedQuestionIndex + 1)
    expect(summaryIndex).toBe(selectedAnswerIndex + 1)
    expect(laterAnsweredQuestionIndex).toBeGreaterThan(summaryIndex)
    for (const request of requests) {
      const system = request.messages.filter(message => message.role === "system").flatMap(message => message.content)
        .flatMap(part => part.type === "text" ? [part.text] : []).join("\n")
      expect(system).toContain("immediately following an answered question and answer")
      expect(system).toContain("refreshed current TaskGraph")
      expect(system).not.toContain(questionText)
      expect(system).not.toContain(answerText)
      expect(system).not.toContain("question-item-1")
      expect(system).not.toContain("question-item-2")
      expect(system).not.toContain("resumed-steer-input")
      expect(system).not.toContain("inputThroughSequence")
      expect(system).not.toContain(originalText)
    }
    expect(requestMessages[0]).toContain(steerParts[0])
    expect(requestMessages[0]).toContain(steerParts[1])
    expect(requestMessages[1]).not.toContain(steerParts[0])
    expect(requestMessages[1]).not.toContain(steerParts[1])
    const agendas = events.filter(event => event.type === COGNITIVE_AGENDA_EVENT_TYPE).map(event => event.payload as { planRevision: number; signals: { pendingInputs: { ids: readonly string[] } } })
    expect(agendas.map(agenda => agenda.planRevision)).toEqual([0, 1])
    expect(agendas.map(agenda => agenda.signals.pendingInputs.ids)).toEqual([[steer.id], []])
    expect(JSON.stringify(agendas)).not.toContain(originalInput.id)
    expect(JSON.stringify(events)).not.toContain(originalText)
    expect(JSON.stringify(events)).not.toContain(answerText)
    expect(steerParts.every(part => !JSON.stringify(events).includes(part))).toBe(true)
    expect(checkpoints.map(checkpoint => checkpoint.consumedInputIds)).toEqual([[], []])
    expect(checkpoints.map(checkpoint => checkpoint.inputThroughSequence)).toEqual([3n, 3n])
  })

  it("keeps the native receipt graph gate on planner roots without a root-store graph checker", async () => {
    const digest = "c".repeat(64)
    const child = { taskId: "child-1", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/child-1", depth: 1, role: "scout", taskType: "research", status: "queued" as const }
    const nativeCoordination = {
      schemaVersion: "agent-harness.v2.native-coordination-receipt.v1", operationKind: "spawn", status: "accepted", replay: false,
      operationId: "native-op-1", requestFingerprint: digest, graphRevision: 2, nodeKey: "node-1", dispatchDisposition: "pending",
      rootTaskId: "root-1", child,
    }
    const currentNode = {
      key: "node-1", templateId: "native:scout", goal: "Inspect", successCriteria: [], dependsOn: [], taskId: child.taskId,
      status: "queued" as const, readiness: "ready" as const, resultSummary: null, failureReason: null,
      native: { operationKind: "spawn" as const, operationId: "native-op-1", requestFingerprint: digest, callerTaskId: "root-1", role: "scout", taskType: "research", contextDigest: digest },
    }
    let reads = 0
    const readCurrent = vi.fn(async (): Promise<TaskGraphCurrentState> => ++reads >= 3
      ? { revision: 2, nodes: [currentNode] }
      : { revision: reads, nodes: [] })
    const commandPort: TaskGraphCommandPort = {
      appendAndSchedule: vi.fn(async () => ({ status: "accepted" as const, revision: 0, nodes: [], readyTaskIds: [] })),
      appendNativeCoordination: vi.fn(async () => ({ status: "accepted" as const, replay: false, operationId: "native-op-1", requestFingerprint: digest, graphRevision: 2, nodeKey: "node-1", dispatchDisposition: "pending" as const, child })),
      readCurrent,
    }
    const roots = { ensure: vi.fn(async () => ({ id: "root-1", attemptCount: 1 } as never)), finish: vi.fn(async () => undefined) }
    const events: RuntimeEvent[] = [], runtimeTools = tools(true), definitions = [...runtimeTools.registry.list()]
    const route = vi.fn(async (_context: unknown, call: { id: string; toolName: string; toolVersion: string }) => ({
      ...call, status: "completed" as const, output: { ...child, replay: false, nativeCoordination }, errorCode: null,
    }))
    let modelCalls = 0
    const runtime = await createCanonicalTurnRuntime(emptyPlanningLedgerPool(), {
      workerId: "worker-1", productionFlags: resolveProductionAgentFlags({
        ENABLE_AGENT_TASK_GRAPH_PLANNING: "1", ENABLE_AGENT_CHILD_EXECUTION: "1", ENABLE_AGENT_WAIT_RESOLVER: "1",
      }),
      taskGraphCommandPort: commandPort, taskGraphTemplates: { scout: { role: "scout", taskType: "research", allowedActions: ["jobs.search"] } },
      stateLoader: async () => ({ ...state(), toolPolicySnapshot: {} }), rootTaskStore: roots as never,
      nativeVerificationFactory: () => nativeVerificationRuntime("failed"),
      turnEngineStoreFactory: () => store(events), contextBuilderFactory: () => contextBuilder(),
      toolRuntimeFactory: () => ({ ...runtimeTools,
        registry: { ...runtimeTools.registry, list: () => definitions, register: (definition: { name: string; version: string }) => definitions.push(definition) },
        router: { execute: route },
      }) as never,
      modelRuntimeFactory: async () => ({ adapter: model(() => ++modelCalls === 1
        ? [{ type: "tool_call_completed", callId: "spawn-call", name: "agent.spawn", arguments: { role: "scout", taskType: "research", goal: "Inspect" } }, { type: "completed", finishReason: "tool_calls" }]
        : [{ type: "text_delta", text: "done" }, { type: "completed", finishReason: "stop" }]), registry: {} as never, candidates: [] }),
      authorizeUsage: async () => ({ settle: async () => undefined }),
    })

    const result = await runtime.execute({ lease, signal: new AbortController().signal })

    expect(readCurrent.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(events.some(event => event.type === "final.rejected" && JSON.stringify(event.payload).includes("task_graph_verification_unverified"))).toBe(true)
    expect(result.status).toBe("failed")
    expect(roots.finish).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({ status: "failed" }) }))
  })

  it("routes planner-root delegation through the default production tool runtime with its bound root attempt", async () => {
    const digest = "d".repeat(64)
    const rootTaskId = "root-turn-1"
    const childTaskId = "subagent-11111111-1111-4111-8111-111111111111"
    const child = { taskId: childTaskId, rootTaskId, parentTaskId: rootTaskId, path: `/${rootTaskId}/${childTaskId}`, depth: 1, role: "scout", taskType: "research", status: "queued" as const }
    const currentNode = {
      key: "native-node-1", templateId: "native:scout", goal: "Inspect", successCriteria: [], dependsOn: [], taskId: child.taskId,
      status: "queued" as const, readiness: "ready" as const, resultSummary: null, failureReason: null,
      native: { operationKind: "spawn" as const, operationId: "native-op-default", requestFingerprint: digest, callerTaskId: rootTaskId, role: "scout", taskType: "research", contextDigest: digest },
    }
    const graph: TaskGraphCurrentState = { revision: 2, nodes: [currentNode] }
    const nativeInputs: TaskGraphNativeCommandInput[] = []
    let graphReads = 0
    const commandPort: TaskGraphCommandPort = {
      appendAndSchedule: vi.fn(async () => ({ status: "accepted" as const, revision: 1, nodes: [], readyTaskIds: [] })),
      appendNativeCoordination: vi.fn(async input => {
        nativeInputs.push(input)
        return { status: "accepted" as const, replay: false, operationId: "native-op-default", requestFingerprint: digest, graphRevision: 2, nodeKey: "native-node-1", dispatchDisposition: "pending" as const, child }
      }),
      readCurrent: vi.fn(async () => ++graphReads === 1 ? { revision: 0, nodes: [] } : graph),
    }
    const rootRow = {
      id: rootTaskId, userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId, parentTaskId: null,
      path: `/${rootTaskId}`, depth: 0, role: "orchestrator", taskType: "root", status: "running", goal: "Find jobs", context: {},
      attemptCount: 7, maxAttempts: 1, leaseOwner: "worker-1", leaseExpiresAt: lease.leaseExpiresAt, interruptRequestedAt: null, result: null, failureReason: null,
    }
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('UPDATE "agent_sessions"')) return { rows: [{ eventSequence: "1" }], rowCount: 1 }
        if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [rootRow], rowCount: 1 }
        if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    const pool = { connect: vi.fn(async () => client), query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }
    const roots = { ensure: vi.fn(async () => ({ id: rootTaskId, attemptCount: 7 } as never)), checkCompletion: vi.fn(async () => ({ ok: true as const })), finish: vi.fn(async () => undefined) }
    const events: RuntimeEvent[] = []
    const modelSnapshots: CanonicalTurnState["snapshot"][] = []
    let modelCalls = 0
    const runtime = await createCanonicalTurnRuntime(emptyPlanningLedgerPool(pool as unknown as Pick<pg.Pool, "connect">), {
      workerId: "worker-1", productionFlags: resolveProductionAgentFlags({
        ENABLE_AGENT_TASK_GRAPH_PLANNING: "1", ENABLE_AGENT_CHILD_EXECUTION: "1", ENABLE_AGENT_WAIT_RESOLVER: "1",
      }),
      taskGraphCommandPort: commandPort, taskGraphTemplates: { scout: { role: "scout", taskType: "research", allowedActions: ["jobs.search"] } },
      stateLoader: async () => ({ ...state(), toolPolicySnapshot: {} }), rootTaskStore: roots as never,
      nativeVerificationFactory: () => nativeVerificationRuntime(),
      turnEngineStoreFactory: () => store(events), contextBuilderFactory: () => ({
        build: async request => { modelSnapshots.push(request.snapshot); return contextBuilder().build(request) },
      }),
      modelRuntimeFactory: async () => ({ adapter: model(() => ++modelCalls === 1
        ? [{ type: "tool_call_completed", callId: "spawn-call-default", name: "agent.spawn", arguments: { role: "scout", taskType: "research", goal: "Inspect" } }, { type: "completed", finishReason: "tool_calls" }]
        : [{ type: "text_delta", text: "done" }, { type: "completed", finishReason: "stop" }]), registry: {} as never, candidates: [] }),
      authorizeUsage: async () => ({ settle: async () => undefined }),
    })

    const result = await runtime.execute({ lease, signal: new AbortController().signal })

    expect(result.status).toBe("completed")
    expect(commandPort.appendNativeCoordination).toHaveBeenCalledOnce()
    expect(nativeInputs[0]?.scope).toMatchObject({
      userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId, parentTaskId: rootTaskId,
      turnLeaseOwner: lease.ownerId, turnLeaseVersion: lease.leaseVersion, parentLeaseOwner: lease.ownerId, parentAttemptCount: 7,
    })
    expect(nativeInputs[0]?.request).toMatchObject({ kind: "spawn", role: "scout", taskType: "research", goal: "Inspect" })
    const persisted = events.find(event => event.type === "tool_call.completed" && JSON.stringify(event.payload).includes("nativeCoordination"))
    expect(persisted).toBeDefined()
    expect(graphReads).toBeGreaterThanOrEqual(3)
    const refreshed = modelSnapshots[1]
    expect(refreshed?.toolObservations.find(item => item.id === "task-graph-current")?.content).toMatchObject({ kind: "task_graph_current", revision: 2 })
    expect(nativeCoordinationReceipts(refreshed!)).toMatchObject([{ operationId: "native-op-default", requestFingerprint: digest, rootTaskId, child: { taskId: childTaskId } }])
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
    const runtime = await createCanonicalTurnRuntime(emptyPlanningLedgerPool(), {
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
    const agenda = recoveredEvents.find(event => event.type === "cognitive.agenda")
    expect(modelMessages).not.toContain(privateSentinel)
    expect(modelMessages).not.toContain(reconciledSentinel)
    expect(modelMessages).not.toContain("jobs.get")
    expect(modelMessages).toContain("job-42")
    expect(requests[0]?.messages.some(message => message.content.some(part => part.type === "text" && part.text.includes('"revision":7')))).toBe(true)
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
    expect(modelContext?.taskGraphRevision).toBe(7)
    expect(agenda?.payload).toMatchObject({ stepId: requests[0]?.metadata.stepId, goalRevision: null, planRevision: 7 })
    expect(readCurrent).toHaveBeenCalledTimes(3)
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

  it("recalls prior same-job outcomes without compaction records into the next captured model request", async () => {
    const graph = {
      revision: 4,
      nodes: [{
        key: "analyst-key", taskId: "analyst-task", templateId: "analyst", goal: "CURRENT_GRAPH_RUNTIME_SENTINEL", successCriteria: [], dependsOn: [],
        status: "completed", readiness: "terminal", resultSummary: null, failureReason: null,
        resultProjection: {
          schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available",
          role: "analyst", status: "completed", findingCount: 1, evidenceCount: 1,
          findings: [{ jobId: "job-1", score: 8, evidenceKinds: ["job"] }],
        },
      }],
    }
    const priorGraph = { ...graph, nodes: graph.nodes.map(node => ({ ...node, resultProjection: {
      ...node.resultProjection, findings: [{ jobId: "job-1", score: 6.5, evidenceKinds: ["job"] }],
    } })) }
    const priorHistory = projectSelectedJobMemory({ jobId: "job-1", sourceTurnId: "private-prior-turn", sourceRootTaskId: "private-prior-root", throughSequence: "9", graph: priorGraph })!
    const outcome: ValidatedSelectedJobHistoryOutcome = {
      jobId: "job-1", sourceTurnId: "private-prior-turn", sourceRootTaskId: "private-prior-root", terminalSequence: 29n, nodes: priorHistory.nodes,
    }
    const currentGraph = graph as unknown as TaskGraphCurrentState
    const commandPort: TaskGraphCommandPort = {
      appendAndSchedule: vi.fn(async () => ({ status: "accepted" as const, revision: 4, nodes: [], readyTaskIds: [] })),
      readCurrent: vi.fn(async () => currentGraph),
    }
    const requests: HarnessModelRequest[] = []
    const events: RuntimeEvent[] = []
    let eventTypesAtHistoryRead: string[] = []
    selectedJobDirectHistory.load.mockReset()
    selectedJobDirectHistory.load.mockImplementation(async () => {
      eventTypesAtHistoryRead = events.map(event => event.type)
      return [outcome]
    })
    const flags = resolveProductionAgentFlags({ ENABLE_AGENT_TASK_GRAPH_PLANNING: "1", ENABLE_AGENT_CHILD_EXECUTION: "1", ENABLE_AGENT_WAIT_RESOLVER: "1" })
    const compactionRunner = vi.fn(async () => ({ status: "compacted" }))
    const planningTools = tools(true)
    const runtime = await createCanonicalTurnRuntime({ connect: vi.fn() } as never, {
      workerId: "worker-1", productionFlags: flags, coordinationEnabled: true, taskGraphCommandPort: commandPort,
      selectedJobPreparationLoader: async () => ({ jobId: "job-1" }),
      stateLoader: async () => ({
        ...selectedJobState(), toolPolicySnapshot: {}, selectedJobMemories: [],
        snapshot: { ...selectedJobState().snapshot, toolObservations: [
          { id: "task-graph-current", content: { kind: "task_graph_current", revision: graph.revision, nodes: graph.nodes } },
          { id: "unrelated-search", content: { toolName: "jobs.search", output: "must be filtered" } },
        ] },
      }),
      rootTaskStore: rootStore() as never, toolRuntimeFactory: () => ({ ...planningTools, registry: { ...planningTools.registry, register: vi.fn() } }) as never,
      turnEngineStoreFactory: () => store(events), contextBuilderFactory: () => contextBuilder(),
      turnBoundaryCompactionRunner: compactionRunner,
      modelRuntimeFactory: async () => ({ adapter: {
        ...model(() => []),
        async *stream(request: HarnessModelRequest) { requests.push(request); yield { type: "text_delta", text: "done" }; yield { type: "completed", finishReason: "stop" } },
      }, registry: {} as never, candidates: [] }),
      authorizeUsage: async () => ({ settle: async () => undefined }),
    })

    await runtime.execute({ lease, signal: new AbortController().signal })
    const requestText = requests[0]?.messages.flatMap(message => message.content).flatMap(part => part.type === "text" ? [part.text] : []).join("\n") ?? ""
    expect(requestText).toContain("selected_job_history")
    expect(requestText).toContain('"score":6.5')
    expect(requestText).toContain("CURRENT_GRAPH_RUNTIME_SENTINEL")
    expect(requestText).not.toContain("selected_job_memory")
    expect(eventTypesAtHistoryRead).toContain("turn.started")
    expect(eventTypesAtHistoryRead).toContain("step.started")
    expect(eventTypesAtHistoryRead.indexOf("turn.started")).toBeLessThan(eventTypesAtHistoryRead.indexOf("step.started"))
    const loadedStepId = (selectedJobDirectHistory.load.mock.calls[0]?.[0] as { stepId?: unknown } | undefined)?.stepId
    const startedStep = events.find(event => event.type === "step.started")
    expect(loadedStepId).toBe((startedStep?.payload as { stepId?: unknown } | undefined)?.stepId)
    expect(selectedJobDirectHistory.load).toHaveBeenCalledTimes(1)
    expect(selectedJobDirectHistory.load.mock.calls[0]?.[0]).not.toHaveProperty("records")
    expect(selectedJobHistory.load).not.toHaveBeenCalled()
    expect(compactionRunner).not.toHaveBeenCalled()
    expect(flags.turnBoundaryCompactionEnabled).toBe(false)
    expect(requestText).not.toContain("private-prior-turn")
    expect(requestText).not.toContain("private-prior-root")
    expect(requestText).not.toContain("must be filtered")
  })

  it("keeps valid same-Turn selected-job memory with direct prior history in the captured request", async () => {
    const graph = {
      revision: 4,
      nodes: [{
        key: "analyst-key", taskId: "analyst-task", templateId: "analyst", goal: "CURRENT_GRAPH_WITH_MEMORY", successCriteria: [], dependsOn: [],
        status: "completed", readiness: "terminal", resultSummary: null, failureReason: null,
        resultProjection: {
          schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available",
          role: "analyst", status: "completed", findingCount: 1, evidenceCount: 1,
          findings: [{ jobId: "job-1", score: 8, evidenceKinds: ["job"] }],
        },
      }],
    }
    const sameTurnMemory = projectSelectedJobMemory({ jobId: "job-1", sourceTurnId: lease.turnId, sourceRootTaskId: "root-1", throughSequence: "19", graph })!
    const otherJobGraph = { ...graph, nodes: graph.nodes.map(node => ({ ...node, resultProjection: {
      ...node.resultProjection, findings: [{ jobId: "other-job-559", score: 9, evidenceKinds: ["job"] }],
    } })) }
    const otherJobMemory = projectSelectedJobMemory({ jobId: "other-job-559", sourceTurnId: lease.turnId, sourceRootTaskId: "root-1", throughSequence: "20", graph: otherJobGraph })!
    const priorGraph = { ...graph, nodes: graph.nodes.map(node => ({ ...node, resultProjection: {
      ...node.resultProjection, findings: [{ jobId: "job-1", score: 6.5, evidenceKinds: ["job"] }],
    } })) }
    const priorHistory = projectSelectedJobMemory({ jobId: "job-1", sourceTurnId: "private-prior-turn", sourceRootTaskId: "private-prior-root", throughSequence: "9", graph: priorGraph })!
    const outcome: ValidatedSelectedJobHistoryOutcome = {
      jobId: "job-1", sourceTurnId: "private-prior-turn", sourceRootTaskId: "private-prior-root", terminalSequence: 29n, nodes: priorHistory.nodes,
    }
    const requests: HarnessModelRequest[] = []
    selectedJobDirectHistory.load.mockReset().mockImplementation(async () => [outcome])
    const flags = resolveProductionAgentFlags({ ENABLE_AGENT_TASK_GRAPH_PLANNING: "1", ENABLE_AGENT_CHILD_EXECUTION: "1", ENABLE_AGENT_WAIT_RESOLVER: "1" })
    const planningTools = tools(true)
    const runtime = await createCanonicalTurnRuntime({ connect: vi.fn() } as never, {
      workerId: "worker-1", productionFlags: flags, coordinationEnabled: true,
      taskGraphCommandPort: {
        appendAndSchedule: vi.fn(async () => ({ status: "accepted" as const, revision: 4, nodes: [], readyTaskIds: [] })),
        readCurrent: vi.fn(async () => graph as unknown as TaskGraphCurrentState),
      },
      selectedJobPreparationLoader: async () => ({ jobId: "job-1" }),
      stateLoader: async () => ({
        ...selectedJobState(), toolPolicySnapshot: {}, selectedJobMemories: [sameTurnMemory, otherJobMemory],
        snapshot: { ...selectedJobState().snapshot, toolObservations: [
          { id: "task-graph-current", content: { kind: "task_graph_current", revision: graph.revision, nodes: graph.nodes } },
        ] },
      }),
      rootTaskStore: rootStore() as never,
      toolRuntimeFactory: () => ({ ...planningTools, registry: { ...planningTools.registry, register: vi.fn() } }) as never,
      turnEngineStoreFactory: () => store(), contextBuilderFactory: () => contextBuilder(),
      modelRuntimeFactory: async () => ({ adapter: {
        ...model(() => []),
        async *stream(request: HarnessModelRequest) { requests.push(request); yield { type: "text_delta", text: "done" }; yield { type: "completed", finishReason: "stop" } },
      }, registry: {} as never, candidates: [] }),
      authorizeUsage: async () => ({ settle: async () => undefined }),
    })

    await runtime.execute({ lease, signal: new AbortController().signal })
    const requestText = requests[0]?.messages.flatMap(message => message.content).flatMap(part => part.type === "text" ? [part.text] : []).join("\n") ?? ""
    expect(requestText).toContain("selected_job_history")
    expect(requestText).toContain("selected_job_memory")
    expect(requestText).toContain('"score":6.5')
    expect(requestText).toContain('"score":8')
    expect(requestText).toContain("CURRENT_GRAPH_WITH_MEMORY")
    expect(requestText).not.toContain("other-job-559")
    expect(requestText).not.toContain("private-prior-turn")
    expect(requestText).not.toContain("private-prior-root")
    expect(selectedJobDirectHistory.load).toHaveBeenCalledTimes(1)
    expect(selectedJobDirectHistory.load.mock.calls[0]?.[0]).not.toHaveProperty("records")
    expect(selectedJobHistory.load).not.toHaveBeenCalled()
  })

  it("does not inject selected-job memory into an ordinary Turn model request", async () => {
    const jobId = "ordinary-job-559"
    const selectedMemory = projectSelectedJobMemory({ jobId, sourceTurnId: lease.turnId, sourceRootTaskId: "root-1", throughSequence: "19", graph: {
      revision: 4, nodes: [{ key: "analyst-key", taskId: "analyst-task", templateId: "analyst", status: "completed", readiness: "terminal",
        resultProjection: { schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available", role: "analyst",
          status: "completed", findingCount: 1, evidenceCount: 1, findings: [{ jobId, score: 8.75, evidenceKinds: ["job"] }] } }],
    } })!
    const requests: HarnessModelRequest[] = []
    const ordinaryTools = tools()
    const runtime = await createCanonicalTurnRuntime({ connect: vi.fn() } as never, {
      workerId: "worker-1", stateLoader: async () => ({ ...state(), selectedJobMemories: [selectedMemory] }),
      rootTaskStore: rootStore() as never, toolRuntimeFactory: () => ordinaryTools as never,
      turnEngineStoreFactory: () => store(), contextBuilderFactory: () => contextBuilder(),
      modelRuntimeFactory: async () => ({ adapter: {
        ...model(() => []),
        async *stream(request: HarnessModelRequest) { requests.push(request); yield { type: "text_delta", text: "done" }; yield { type: "completed", finishReason: "stop" } },
      }, registry: {} as never, candidates: [] }),
      authorizeUsage: async () => ({ settle: async () => undefined }),
    })

    await runtime.execute({ lease, signal: new AbortController().signal })
    expect(requests).toHaveLength(1)
    expect(selectedJobDirectHistory.load).not.toHaveBeenCalled()
    const requestText = JSON.stringify(requests[0]?.messages)
    expect(requestText).not.toContain("selected_job_memory")
    expect(requestText).not.toContain(JSON.stringify(selectedMemory))
    expect(requestText).not.toContain(jobId)
  })

  it("fails closed before provider invocation when the scoped current graph read fails", async () => {
    const provider = vi.fn(async () => ({ adapter: model(() => []), registry: {} as never, candidates: [] }))
    const taskGraphCommandPort: TaskGraphCommandPort = {
      appendAndSchedule: async () => ({ status: "accepted", revision: 1, nodes: [], readyTaskIds: [] }),
      readCurrent: async () => { throw Object.assign(new Error("TaskGraph read unavailable"), { code: "task_graph_read_failed" }) },
    }
    const runtime = await createCanonicalTurnRuntime({ connect: vi.fn() } as never, {
      workerId: "worker-1", taskGraphCommandPort, taskGraphTemplates: { scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] } },
      productionFlags: { taskGraphPlanningEnabled: true, childExecutionEnabled: true, coordinationEnabled: true, consumeWaitOutcomes: false, canonicalAutomationEnabled: false, turnBoundaryCompactionEnabled: false },
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
    const selectedTemplateActions = ["jobs.get", "persona.retrieve", "resume.get_base", "cover_letter.draft", "artifact.version.read", "artifact.review"]
    const selected = await taskGraphRootSurface(true)
    const generic = await taskGraphRootSurface(false)

    expect(selected.toolNames).not.toEqual(expect.arrayContaining(selectedJobDenied))
    expect(selected.allowedActions).not.toEqual(expect.arrayContaining(selectedJobDenied))
    expect(selected.toolNames).not.toEqual(expect.arrayContaining(genericReads))
    expect(selected.toolNames.slice().sort()).toEqual([...retained].sort())
    expect(selected.allowedActions.slice().sort()).toEqual([...retained, ...selectedTemplateActions].sort())
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

  it("activates discovery restrictions only for the trusted intent and persists a failed root marker without a validated shortlist", async () => {
    const discovery = await taskGraphRootSurface(false, false, "jobs.get", "jobs.get", true)
    const safeRootTools = ["agent.plan", "agent.wait", "agent.list", "list_subagents"]
    const discoveryTemplateActions = ["jobs.search", "jobs.get", "persona.retrieve", "resume.get_base"]
    expect(discovery.toolNames.slice().sort()).toEqual([...safeRootTools].sort())
    expect(discovery.toolNames).not.toEqual(expect.arrayContaining([...discoveryTemplateActions, "agent.spawn", "agent.send", "agent.interrupt", "agent.close", "writer", "reviewer"]))
    expect(discovery.allowedActions.slice().sort()).toEqual([...safeRootTools, ...discoveryTemplateActions].sort())
    expect(discovery.allowedActions).not.toEqual(expect.arrayContaining(["cover_letter.draft", "artifact.review"]))
    expect(JSON.stringify(discovery.requests[0]?.tools.find(tool => tool && typeof tool === "object" && "name" in tool && tool.name === "agent.plan"))).toContain("analyst")
    expect(JSON.stringify(discovery.requests[0]?.tools.find(tool => tool && typeof tool === "object" && "name" in tool && tool.name === "agent.plan"))).not.toContain("writer")
    expect(discovery.route).not.toHaveBeenCalled()
    expect(JSON.stringify(discovery.events)).toContain("interactive_discovery_root_tool_disabled")
    expect(discovery.roots.finish).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({ status: "failed" }),
      metadata: { interactiveDiscoveryShortlist: { schemaVersion: 1, status: "failed", items: [], failures: ["discovery_runtime_failed"] } },
    }))

    const legacy = await taskGraphRootSurface(false)
    expect(legacy.toolNames).toEqual(expect.arrayContaining(["jobs.search", "jobs.get", "agent.spawn", "agent.send"]))

    const recovered = await taskGraphRootSurface(false, true, "agent.spawn", "jobs.get", true)
    expect(recovered.route).not.toHaveBeenCalled()
    expect(JSON.stringify(recovered.events)).toContain("interactive_discovery_root_tool_disabled")
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

  it.each([
    { name: "unchanged source", sourceDigest: `sha256:${"b".repeat(64)}`, status: "completed" },
    { name: "source changed after review", sourceDigest: `sha256:${"e".repeat(64)}`, status: "failed" },
  ])("revalidates current selected-job sources at completion ($name)", async ({ sourceDigest, status }) => {
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
    const artifactHeadReader = vi.fn(async (scope: { userId: string; sessionId: string; jobId: string; artifactId: string }) => ({
      ...artifactRef, artifactId: scope.artifactId,
    }))
    const reviewRow = {
      id: "review-1", artifactVersionId: "version-1", userId: lease.userId, sessionId: lease.sessionId, jobId: "job-1",
      artifactId: artifactRef.artifactId, version: artifactRef.version, contentHash: artifactRef.contentHash,
      sourceDigest: artifactRef.sourceDigest, currentSourceDigest: artifactRef.sourceDigest, status: "needs_revision",
      findings: [{ private: "review details" }], evidenceRefs: [], taskId: "reviewer-1", toolCallId: "review-call-1",
      requestHash: "request-1", reviewHash: `sha256:${"c".repeat(64)}`, createdAt: new Date(),
    }
    const artifactClient = {
      query: vi.fn(async (sql: string, _values?: readonly unknown[]) => sql.includes('FROM "agent_artifact_review"')
        ? { rows: [reviewRow], rowCount: 1 } : { rows: [], rowCount: 0 }),
      release: vi.fn(),
    }
    const roots = rootStore()
    const sourceDigestLoader = vi.fn(async () => sourceDigest)
    let selectedTerminalGuard: Parameters<TurnEngineStoreFactory>[1] | "not-created" = "not-created"
    const selectedStoreFactory: TurnEngineStoreFactory = (_pool, guard) => {
      selectedTerminalGuard = guard
      return store()
    }
    const productionFlags = resolveProductionAgentFlags({
      ENABLE_AGENT_TASK_GRAPH_PLANNING: "1", ENABLE_AGENT_CHILD_EXECUTION: "1", ENABLE_AGENT_WAIT_RESOLVER: "1",
    })
    const runtime = await createCanonicalTurnRuntime(emptyPlanningLedgerPool({ connect: vi.fn(async () => artifactClient) } as unknown as Pick<pg.Pool, "connect">), {
      workerId: "worker-1", productionFlags, taskGraphCommandPort,
      selectedJobPreparationLoader: async () => ({ jobId: "job-1" }),
      selectedJobArtifactHeadReader: artifactHeadReader,
      selectedJobSourceDigestLoader: sourceDigestLoader,
      stateLoader: async () => ({ ...selectedJobState(), toolPolicySnapshot: {} }), rootTaskStore: roots as never,
      turnEngineStoreFactory: selectedStoreFactory, contextBuilderFactory: () => contextBuilder(),
      modelRuntimeFactory: async () => ({ adapter: {
        ...model(() => []),
        async *stream() {
          yield { type: "text_delta", text: "The cover-letter draft is ready for review." }
          yield { type: "completed", finishReason: "stop" }
        },
      }, registry: {} as never, candidates: [] }),
      authorizeUsage: async () => ({ settle: async () => undefined }),
    })

    await expect(runtime.execute({ lease, signal: new AbortController().signal })).resolves.toMatchObject({ status })
    expect(selectedTerminalGuard).toEqual(expect.any(Function))
    expect(roots.checkCompletion).toHaveBeenCalledOnce()
    expect(taskGraphCommandPort.readCurrent).toHaveBeenCalledTimes(3)
    expect(taskGraphCommandPort.readCurrent).toHaveBeenLastCalledWith({
      userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: "root-1", parentTaskId: "root-1",
      turnLeaseOwner: lease.ownerId, turnLeaseVersion: lease.leaseVersion, parentLeaseOwner: lease.ownerId, parentAttemptCount: 1,
    })
    if (status === "completed") {
      const reviewRead = artifactClient.query.mock.calls.find(([sql]) => String(sql).includes('FROM "agent_artifact_review"'))
      expect(reviewRead?.[0]).toContain('AND "currentSourceDigest"=$8 AND "status"=$9 AND "taskId"=$10 AND "reviewHash"=$11')
      expect(reviewRead?.[0]).toContain('"toolCallId", "reviewHash"')
      expect(reviewRead?.[0]).not.toMatch(/"(findings|evidenceRefs|requestHash)"/)
      expect(reviewRead?.[1]).toEqual([
        lease.userId, lease.sessionId, "job-1", "draft-1", 2, artifactRef.contentHash, artifactRef.sourceDigest,
        artifactRef.sourceDigest, "needs_revision", "reviewer-1", reviewRow.reviewHash,
      ])
      expect(artifactHeadReader).toHaveBeenCalledOnce()
      expect(artifactHeadReader).toHaveBeenCalledWith({ userId: lease.userId, sessionId: lease.sessionId, jobId: "job-1", artifactId: "draft-1" })
    } else {
      expect(artifactHeadReader).not.toHaveBeenCalled()
    }
    expect(sourceDigestLoader).toHaveBeenCalledTimes(status === "completed" ? 2 : 1)
    expect(sourceDigestLoader).toHaveBeenCalledWith(lease.userId, "job-1")
  })

  it("rechecks durable graph verification atomically even when planning is disabled", async () => {
    const roots = rootStore()
    const terminalGuards: Array<Parameters<TurnEngineStoreFactory>[1]> = []
    const ordinaryStoreFactory: TurnEngineStoreFactory = (_pool, guard) => {
      terminalGuards.push(guard)
      return store()
    }
    const fixture = setup({ rootTaskStore: roots, turnEngineStoreFactory: ordinaryStoreFactory })

    await expect((await fixture.runtime).execute({ lease, signal: new AbortController().signal }))
      .resolves.toMatchObject({ status: "completed" })
    expect(terminalGuards[0]).toEqual(expect.any(Function))
    const guard = terminalGuards[0]
    if (typeof guard !== "function") throw new Error("terminal guard was not created")
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as never
    const terminal = { stepId: "step-1", finalItemId: "final-1", finalContent: null, stepCount: 1, toolCallCount: 0, usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }, response: "{}" } as never
    await expect(guard(client, terminal)).resolves.toEqual({ ok: true })
    expect(roots.checkCompletion).toHaveBeenNthCalledWith(1, expect.objectContaining({ taskGraphVerification: true }))
    expect(roots.checkCompletion).toHaveBeenNthCalledWith(2, expect.objectContaining({ taskGraphVerification: true, client }))
  })

  it("keeps selected-job finalization composed after the durable graph guard", async () => {
    const roots = rootStore()
    const planningTools = tools(true)
    const terminalGuards: Array<Parameters<TurnEngineStoreFactory>[1]> = []
    const fixture = setup({
      productionFlags: resolveProductionAgentFlags({ ENABLE_AGENT_TASK_GRAPH_PLANNING: "1", ENABLE_AGENT_CHILD_EXECUTION: "1", ENABLE_AGENT_WAIT_RESOLVER: "1" }),
      taskGraphCommandPort: { appendAndSchedule: vi.fn(async () => ({ status: "accepted", revision: 1, nodes: [], readyTaskIds: [] })), readCurrent: vi.fn(async () => ({ revision: 0, nodes: [] })) },
      rootTaskStore: roots, selectedJobPreparationLoader: async () => ({ jobId: "job-1" }),
      stateLoader: async () => ({ ...selectedJobState(), toolPolicySnapshot: {} }),
      toolRuntimeFactory: () => ({ ...planningTools, registry: { ...planningTools.registry, register: vi.fn() } }),
      turnEngineStoreFactory: (_pool: Parameters<TurnEngineStoreFactory>[0], guard: Parameters<TurnEngineStoreFactory>[1]) => { terminalGuards.push(guard); return store() },
    })
    await (await fixture.runtime).execute({ lease, signal: new AbortController().signal })
    const guard = terminalGuards[0]
    if (typeof guard !== "function") throw new Error("selected-job terminal guard was not created")
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as never
    const terminal = { stepId: "step-1", finalItemId: "final-1", finalContent: null, stepCount: 1, toolCallCount: 0, usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }, response: "{}" } as never

    await expect(guard(client, terminal)).resolves.toMatchObject({ ok: false, blocker: "selected_job_draft_review_required" })
    expect(roots.checkCompletion).toHaveBeenLastCalledWith(expect.objectContaining({ taskGraphVerification: true, client }))
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
    const artifactHeadReader = vi.fn(async () => null)
    const productionFlags = resolveProductionAgentFlags({
      ENABLE_AGENT_TASK_GRAPH_PLANNING: "1", ENABLE_AGENT_CHILD_EXECUTION: "1", ENABLE_AGENT_WAIT_RESOLVER: "1",
    })
    const runtime = await createCanonicalTurnRuntime(emptyPlanningLedgerPool(), {
      workerId: "worker-1", productionFlags, taskGraphCommandPort,
      selectedJobPreparationLoader: async () => ({ jobId: "job-1" }),
      selectedJobArtifactHeadReader: artifactHeadReader,
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
    expect(taskGraphCommandPort.readCurrent).toHaveBeenCalledTimes(2)
    expect(artifactHeadReader).not.toHaveBeenCalled()
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
    expect(redactSensitiveValue(canonicalJobId)).toBe("[REDACTED_PHONE]")
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
    expect(requests[1]?.messages.some(message => JSON.stringify(message).includes(canonicalJobId))).toBe(true)
    expect(JSON.stringify(requests[1]?.messages)).not.toContain("candidate@example.test")
    expect(JSON.stringify(requests[1]?.messages)).not.toContain("sk-secretvalue123")
    expect(events.some(event => event.type === "tool_call.completed" && JSON.stringify(event.payload).includes(canonicalJobId))).toBe(true)
    expect(JSON.stringify(events)).not.toContain("candidate@example.test")
    expect(JSON.stringify(events)).not.toContain("sk-secretvalue123")
    expect(pg.pool.query).toHaveBeenCalledWith(expect.stringContaining('FROM "Job"'), expect.any(Array))
    expect(pg.calls.some(sql => sql === "BEGIN")).toBe(true)
  })


})
