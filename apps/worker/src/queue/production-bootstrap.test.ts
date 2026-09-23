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
import { PLAN_PROPOSAL_SCHEMA_VERSION } from "../runtime/planning/goal-plan-contract.js"
import { createPlanProposalTool } from "../runtime/planning/plan-proposal-tool.js"
import { PLAN_COMPLETION_FEEDBACK_TEXT } from "../runtime/planning/plan-completion-feedback.js"
import { createPgDurableWaitPort } from "../runtime/subagents/durable-wait-store.js"
import { reconcileDurableWaits, startDurableWaitResolver } from "../runtime/subagents/durable-wait-resolver.js"
import type { createSubagentQueue } from "./subagent-queue.js"
import { runTurnJob, type createTurnQueue, type TurnExecutor } from "../runtime/turns/turn-queue.js"
import type { TurnLease } from "../runtime/turns/lease.js"
import { recoverTurnQueue, turnJobId } from "../runtime/turns/recovery-scanner.js"
import { createProductionWorkerBootstrap, startProductionAgentRuntime, type CanonicalTurnRuntime } from "./production-bootstrap.js"
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

vi.mock("../../redis.js", () => ({ redisConnection: {}, redisCommandConnection: {}, closeSharedRedisConnections: async () => undefined }))
vi.mock("ioredis", () => ({ Redis: class { disconnect(): void {} } }))

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

function compositionStore(
  persistedItems: Array<{ type: string; status: string; content: unknown }> = [],
  persistedEvents: Array<{ type: string; payload: unknown }> = [],
): TurnEngineStore {
  const items = new Map<string, { revision: number; type: string }>()
  return {
    startStep: async ({ stepId, ordinal }) => ({ id: stepId, ordinal }),
    updateStep: async () => undefined,
    createItem: async ({ itemId, type, status, content }) => {
      items.set(itemId, { revision: 0, type })
      persistedItems.push({ type, status, content })
      return { id: itemId, revision: 0 }
    },
    updateItem: async ({ itemId, expectedRevision, status, content }) => {
      const item = items.get(itemId)
      if (!item || item.revision !== expectedRevision) throw new Error(`Unknown fixture item ${itemId}`)
      item.revision += 1
      persistedItems.push({ type: item.type, status, content })
      return { id: itemId, revision: item.revision }
    },
    appendEvent: async ({ id, type, payload }) => {
      persistedEvents.push({ type, payload })
      return { id }
    },
    appendEvents: async inputs => {
      for (const { type, payload } of inputs) persistedEvents.push({ type, payload })
      return inputs.map(({ id }) => ({ id }))
    },
    recordFinalResponse: async () => undefined,
  }
}

async function compositionRuntime(): Promise<{ runtime: CanonicalTurnRuntime; tool: ReturnType<typeof vi.fn>; lifecycle: InMemoryToolLifecycleSink; requests: HarnessModelRequest[]; manager: AgentTreeManager; validatedArguments: Array<{ name: string; input: unknown; version?: string }>; persistedItems: Array<{ type: string; status: string; content: unknown }>; persistedEvents: Array<{ type: string; payload: unknown }> }> {
  const tool = vi.fn(async (context: { scope: { userId: string } }) => ({ user: context.scope.userId }))
  const definition: RuntimeToolDefinition = {
    schemaVersion, name: "fixture.read", version: "1", description: "Read deterministic fixture state",
    capabilities: ["read"] as const, inputSchema: Type.Object({}, { additionalProperties: false }),
    outputSchema: Type.Object({ user: Type.String() }, { additionalProperties: false }), risk: "read" as const,
    domain: "jobs" as const, idempotency: "read_only" as const, timeoutMs: 1_000, requiredCapabilities: [] as const,
    execute: tool,
  }
  const registry = new ToolRegistry([definition])
  const validatedArguments: Array<{ name: string; input: unknown; version?: string }> = []
  vi.spyOn(registry, "validateArguments").mockImplementation((name, input, version) => {
    validatedArguments.push({ name, input, ...(version === undefined ? {} : { version }) })
    return ToolRegistry.prototype.validateArguments.call(registry, name, input, version)
  })
  const lifecycle = new InMemoryToolLifecycleSink()
  const router = new ToolRouter(registry, new ToolLifecycle({ sink: lifecycle, references: new InMemoryToolResultReferenceStore() }))
  let calls = 0
  const requests: HarnessModelRequest[] = []
  const persistedItems: Array<{ type: string; status: string; content: unknown }> = []
  const persistedEvents: Array<{ type: string; payload: unknown }> = []
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
    turnEngineStoreFactory: () => compositionStore(persistedItems, persistedEvents),
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
    runtime, tool, lifecycle, requests, manager, validatedArguments, persistedItems, persistedEvents,
  }
}

async function coordinationRuntime(input: { workerId?: string; manager: AgentTreeManager; store: CoordinationStore; wait: DurableWaitPort; model: ModelAdapter; pool?: Parameters<typeof createCanonicalTurnRuntime>[0]; now?: () => Date; consumeWaitOutcomes?: boolean; stateLoader?: (state: CanonicalTurnState, lease: TurnLease) => CanonicalTurnState | Promise<CanonicalTurnState> }): Promise<{ runtime: CanonicalTurnRuntime; execute: CanonicalTurnRuntime["execute"] }> {
  const read: RuntimeToolDefinition = { schemaVersion, name: "fixture.read", version: "1", description: "Read fixture evidence", capabilities: ["read"], inputSchema: Type.Object({}, { additionalProperties: false }), outputSchema: Type.Object({ jobs: Type.Array(Type.Object({ id: Type.String() }, { additionalProperties: false })) }, { additionalProperties: false }), risk: "read", domain: "jobs", idempotency: "read_only", timeoutMs: 1_000, requiredCapabilities: [], execute: async () => ({ jobs: [{ id: "job-fixture" }] }) }
  const registry = new ToolRegistry([read, ...createCoordinationTools({ manager: input.manager, store: input.store, wait: input.wait })])
  const router = new ToolRouter(registry, new ToolLifecycle({ sink: new InMemoryToolLifecycleSink(), references: new InMemoryToolResultReferenceStore() }), createCanonicalPolicy(undefined, true, false))
  const state: CanonicalTurnState = { scope: { userId: "user_fixture" }, goal: "Read fixture state", modelProfileSnapshot: {} as never, toolPolicySnapshot: { role: "orchestrator", capabilities: ["read", "coordination"] }, budgetSnapshot: { limits: { maxSteps: 5 } }, snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] } }
  const runtimeOptions: Parameters<typeof createCanonicalTurnRuntime>[1] = {
    workerId: input.workerId ?? "worker_fixture", manager: input.manager, coordinationEnabled: true,
    ...(input.now ? { now: input.now } : {}),
    ...(input.consumeWaitOutcomes ? { consumeWaitOutcomes: true } : {}),
    ...(input.stateLoader ? { stateLoader: async (_pool, lease) => input.stateLoader!(state, lease) } : {}),
    modelRuntimeFactory: async () => ({ adapter: input.model, registry: {} as never, candidates: [] }),
    toolRuntimeFactory: () => ({ registry, router }),
    rootTaskStore: { ensure: vi.fn(async () => ({ id: "root_fixture" } as never)), finish: vi.fn(async () => undefined) },
    turnEngineStoreFactory: () => compositionStore(),
    contextBuilderFactory: () => new StepContextBuilder({ scope: { userId: "user_fixture" }, withTransaction: async work => work({ getCheckpoint: async () => ({ inputThroughSequence: 0n, consumedInputIds: [] }), claimInputs: async () => ({ inputs: [], newlyClaimedInputIds: [] }), persistCheckpoint: async () => undefined }) } satisfies InputClaimStore),
    authorizeUsage: vi.fn(async () => ({ settle: vi.fn(async () => undefined) })),
  }
  const runtime = await createCanonicalTurnRuntime(input.pool ?? ({ connect: vi.fn() } as never), runtimeOptions)
  return { runtime, execute: runtime.execute }
}

type DurableCompositionRow = Record<string, unknown>

/**
 * A small PostgreSQL-shaped state machine for the composition test. It keeps
 * the SQL transaction entry points and the row-level fences visible while
 * avoiding a live database in this focused suite.
 */
function durableCompositionPool(input: {
  readonly root: SubagentTaskRecord
  readonly tasks: Map<string, SubagentTaskRecord>
  readonly now: Date
}) {
  type DurableCompositionTurn = {
    id: string
    userId: string
    sessionId: string
    rootTaskId: string | null
    status: string
    leaseOwnerId: string | null
    leaseVersion: number
    leaseExpiresAt: Date | null
    leaseStartedAt: Date | null
  }
  const turn: DurableCompositionTurn = {
    id: String(input.root.turnId), userId: input.root.userId, sessionId: input.root.sessionId, rootTaskId: input.root.rootTaskId,
    status: "in_progress", leaseOwnerId: "worker_root", leaseVersion: 1,
    leaseExpiresAt: new Date(input.now.getTime() + 60_000), leaseStartedAt: input.now,
  }
  const state = {
    session: { id: input.root.sessionId, userId: input.root.userId, status: "running", eventSequence: 40 },
    turn,
    step: { id: "step_pending", ordinal: 3, taskId: input.root.id, turnId: input.root.turnId, sessionId: input.root.sessionId, attempt: 1, status: "waiting_for_tool", inputThroughSequence: "0", consumedInputIds: [], inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    wait: null as DurableCompositionRow | null,
    events: [] as DurableCompositionRow[],
    outbox: [] as DurableCompositionRow[],
    calls: [] as string[],
  }
  const row = (value: DurableCompositionRow): DurableCompositionRow => ({ ...value })
  const rootRow = (): DurableCompositionRow => ({ id: input.root.id, rootTaskId: input.root.rootTaskId, turnId: input.root.turnId, sessionId: input.root.sessionId, status: input.root.status, userId: input.root.userId, path: input.root.path })
  const turnRow = (): DurableCompositionRow => ({ ...state.turn })
  const taskRows = (ids: readonly string[]): DurableCompositionRow[] => ids.flatMap(id => {
    const task = input.tasks.get(id)
    return task ? [{ id: task.id, rootTaskId: task.rootTaskId, turnId: task.turnId, sessionId: task.sessionId, status: task.status, userId: task.userId, role: task.role, result: task.result, failureReason: task.failureReason }] : []
  })
  const waitRow = (): DurableCompositionRow | undefined => state.wait ? row(state.wait) : undefined
  const response = <T>(rows: DurableCompositionRow[], rowCount = rows.length) => ({ rows: rows as T[], rowCount })
  const client = {
    query: vi.fn(async <T = DurableCompositionRow>(sql: string, params: readonly unknown[] = []) => {
      state.calls.push(sql)
      const statement = sql.trim()
      if (statement === "BEGIN" || statement === "COMMIT" || statement === "ROLLBACK" || sql.includes("set_config")) return response<T>([], 1)

      if (sql.includes('SELECT session."userId", session."controlGate"')) {
        return response<T>(state.session.status === "running" ? [{ userId: state.session.userId, controlGate: "open" }] : [], state.session.status === "running" ? 1 : 0)
      }
      if (sql.includes('SELECT session."id" FROM "agent_sessions"')) {
        return response<T>(state.session.status === "running" ? [{ id: state.session.id }] : [], state.session.status === "running" ? 1 : 0)
      }
      if (sql.includes('SELECT "id", "sessionId", "userId", "status", "leaseOwnerId"') && sql.includes('FROM "agent_turns" WHERE "id" = $1') && sql.includes("FOR UPDATE")) {
        const queryNow = params[5] instanceof Date ? params[5] : new Date(String(params[5]))
        const owned = String(params[0]) === state.turn.id && String(params[1]) === state.turn.sessionId && String(params[2]) === state.turn.userId &&
          String(params[3]) === state.turn.leaseOwnerId && Number(params[4]) === state.turn.leaseVersion && state.turn.status === "in_progress" &&
          state.turn.leaseExpiresAt !== null && state.turn.leaseExpiresAt.getTime() > queryNow.getTime()
        return response<T>(owned ? [{ ...turnRow(), input: { goal: "Read fixture state" }, contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: { role: "orchestrator", capabilities: ["read", "coordination"] }, budgetSnapshot: { limits: { maxSteps: 5 } } }] : [], owned ? 1 : 0)
      }
      if (sql.includes('SELECT session."id", session."userId", session."status"')) {
        return response<T>(state.session.status === "running" ? [{ ...state.session }] : [], state.session.status === "running" ? 1 : 0)
      }
      if (sql.includes('UPDATE "agent_sessions"')) {
        state.session.eventSequence += 1
        return response<T>([{ eventSequence: String(state.session.eventSequence) }], 1)
      }

      if (sql.includes("WITH candidates AS") && sql.includes('UPDATE "agent_outbox"')) return response<T>([])
      if (sql.includes("WITH stale AS") && sql.includes('UPDATE "agent_turns"')) return response<T>([])
      if (sql.includes('LEFT JOIN "agent_outbox" AS dispatch') && sql.includes('turn."status" = \'queued\'')) return response<T>([])

      if (sql.includes('FROM "agent_wait_conditions"')) {
        const current = waitRow()
        if (!current) return response<T>([])
        if (sql.includes('"turnId" = $3')) {
          if (sql.includes('"parentTaskId" = $4') && sql.includes('"status" IN (\'ready\', \'timed_out\')')) {
            return response<T>(String(params[2]) === state.turn.id && String(params[3]) === input.root.id && ["ready", "timed_out"].includes(String(current.status)) && current.suspendedAt != null ? [current] : [])
          }
          return response<T>(String(params[2]) === state.turn.id && String(current.status) !== "closed" && current.consumedAt == null ? [current] : [])
        }
        if (String(params[0]) === String(current.id) || (String(params[0]) === input.root.id && String(params[1]) === String(current.idempotencyKey))) return response<T>([current])
        return response<T>([])
      }

      if (sql.includes('SELECT MAX("ordinal") AS "maxOrdinal" FROM "agent_steps"')) return response<T>([{ maxOrdinal: state.step.ordinal }])
      if (sql.includes('FROM "agent_steps"')) {
        if (sql.includes('WHERE "id" = $1') && typeof params[0] === "string") state.step.id = params[0]
        return response<T>([{ ...state.step }])
      }

      if (sql.includes('FROM "agent_items" AS item LEFT JOIN')) return response<T>([])
      if (sql.includes('FROM "agent_items" WHERE')) return response<T>([])
      if (sql.includes('FROM "agent_inputs"')) return response<T>([])
      if (sql.includes('FROM "agent_context_snapshots"')) return response<T>([])

      if (sql.includes('ANY($1::text[])')) {
        const ids = Array.isArray(params[0]) ? params[0].map(String) : []
        return response<T>(taskRows(ids))
      }
      if (sql.includes('FROM "sub_agent_tasks" AS task')) {
        return response<T>(String(params[0]) === input.root.id ? [rootRow()] : [])
      }

      if (sql.includes('JOIN "agent_turns" AS turn')) {
        const active = ["in_progress", "waiting_for_dependency"].includes(state.turn.status)
        return response<T>(active ? [turnRow()] : [], active ? 1 : 0)
      }
      if (sql.includes('FROM "agent_turns" AS turn')) return response<T>([turnRow()])

      if (sql.includes('INSERT INTO "agent_wait_conditions"')) {
        const targetTaskIds = JSON.parse(String(params[7])) as string[]
        const matchedTaskIds = JSON.parse(String(params[11])) as string[]
        state.step.id = String(params[5])
        state.wait = {
          id: String(params[0]), userId: String(params[1]), sessionId: String(params[2]), turnId: String(params[3]), parentTaskId: String(params[4]), stepId: String(params[5]), idempotencyKey: String(params[6]), targetTaskIds, mode: String(params[8]), status: String(params[9]), deadlineAt: params[10], matchedTaskIds, result: JSON.parse(String(params[12])), createdAt: params[13], updatedAt: params[13], suspendedAt: null, consumedAt: null,
        }
        return response<T>([state.wait])
      }
      if (sql.includes('UPDATE "agent_wait_conditions"')) {
        if (!state.wait) return response<T>([], 0)
        if (sql.includes('SET "result" = jsonb_set')) {
          state.wait.result = { ...(state.wait.result && typeof state.wait.result === "object" ? state.wait.result as DurableCompositionRow : {}), outcome: JSON.parse(String(params[0])) }
          state.wait.consumedAt = params[1]; state.wait.updatedAt = params[1]
          return response<T>([], 1)
        }
        if (sql.includes('SET "status" = $1')) {
          state.wait.status = String(params[0]); state.wait.matchedTaskIds = JSON.parse(String(params[1])); state.wait.resolvedAt = params[2]
          return response<T>([{ id: state.wait.id, status: state.wait.status, deadlineAt: state.wait.deadlineAt, matchedTaskIds: state.wait.matchedTaskIds }])
        }
        state.wait.suspendedAt = params[1]
        return response<T>([], 1)
      }

      if (sql.includes('UPDATE "agent_outbox"') && sql.includes('SET "publishedAt" = CURRENT_TIMESTAMP')) {
        const item = state.outbox.find(value => String(value.id) === String(params[0]) && value.publishedAt == null)
        if (!item) return response<T>([], 0)
        item.publishedAt = new Date(input.now)
        item.attemptCount = Number(item.attemptCount ?? 0) + 1
        return response<T>([], 1)
      }
      if (sql.includes('UPDATE "agent_outbox"')) {
        const idempotencyKey = String(params[0]); const aggregateId = String(params[1])
        const item = state.outbox.find(value => value.topic === "agent.turn.dispatch" && String(value.idempotencyKey) === idempotencyKey && String(value.aggregateId) === aggregateId && value.publishedAt == null)
        if (!item) return response<T>([], 0)
        item.publishedAt = new Date(input.now); item.attemptCount = Number(item.attemptCount ?? 0) + 1
        return response<T>([], 1)
      }

      if (sql.includes('UPDATE "agent_turns"')) {
        if (sql.includes("SET \"status\" = 'in_progress'")) {
          const startedAt = params[3] instanceof Date ? params[3] : new Date(String(params[3])); const leaseMs = Number(params[4])
          const available = state.turn.status === "queued" && (state.turn.leaseOwnerId === null || (state.turn.leaseExpiresAt !== null && state.turn.leaseExpiresAt.getTime() <= startedAt.getTime()))
          if (!available || String(params[0]) !== state.turn.id || String(params[1]) !== state.turn.sessionId) return response<T>([], 0)
          state.turn.status = "in_progress"; state.turn.leaseOwnerId = String(params[2]); state.turn.leaseVersion += 1
          state.turn.leaseStartedAt = startedAt; state.turn.leaseExpiresAt = new Date(startedAt.getTime() + leaseMs)
          return response<T>([{ id: state.turn.id, sessionId: state.turn.sessionId, userId: state.turn.userId, leaseOwnerId: state.turn.leaseOwnerId, leaseVersion: state.turn.leaseVersion, leaseStartedAt: state.turn.leaseStartedAt, leaseExpiresAt: state.turn.leaseExpiresAt }])
        }
        if (sql.includes("SET \"status\" = 'waiting_for_dependency'")) {
          state.turn.status = "waiting_for_dependency"; state.turn.leaseOwnerId = null; state.turn.leaseExpiresAt = null; state.turn.leaseStartedAt = null
        } else if (sql.includes("SET \"status\" = 'queued'")) {
          state.turn.status = "queued"; state.turn.leaseOwnerId = null; state.turn.leaseExpiresAt = null; state.turn.leaseStartedAt = null
        } else if (sql.includes('SET "status" = $5')) {
          const currentNow = params[5] instanceof Date ? params[5] : new Date(String(params[5]))
          const owned = String(params[0]) === state.turn.id && String(params[1]) === state.turn.sessionId && String(params[2]) === state.turn.leaseOwnerId && Number(params[3]) === state.turn.leaseVersion && state.turn.leaseExpiresAt !== null && state.turn.leaseExpiresAt.getTime() > currentNow.getTime()
          if (!owned) return response<T>([], 0)
          state.turn.status = String(params[4]); state.turn.leaseOwnerId = null; state.turn.leaseExpiresAt = null; state.turn.leaseStartedAt = null
          return response<T>([], 1)
        }
        return response<T>([], 1)
      }

      if (sql.includes('FROM "agent_events"')) {
        const found = state.events.filter(event => String(event.sessionId) === String(params[0]) && String(event.idempotencyKey) === String(params[1]))
        return response<T>(found)
      }
      if (sql.includes('INSERT INTO "agent_events"')) {
        const payload = JSON.parse(String(params[6])) as DurableCompositionRow
        const event = { id: String(params[0]), sessionId: String(params[1]), turnId: String(params[2]), sequence: String(params[3]), type: "turn.resumed", actor: "system", correlationId: String(params[2]), causationId: String(params[4]), idempotencyKey: String(params[5]), payload }
        state.events.push(event)
        return response<T>([], 1)
      }

      if (sql.includes('SELECT "id", "topic", "aggregateId", "idempotencyKey", "payload" FROM "agent_outbox"')) {
        return response<T>(state.outbox.filter(item => String(item.idempotencyKey) === String(params[0])))
      }
      if (sql.includes('SELECT dispatch."id", dispatch."aggregateId", dispatch."payload", dispatch."attemptCount"') && sql.includes('FROM "agent_outbox" AS dispatch')) {
        return response<T>(state.outbox.filter(item => String(item.topic) === String(params[0]) && item.publishedAt == null).map(item => ({ id: item.id, aggregateId: item.aggregateId, payload: item.payload, attemptCount: item.attemptCount })))
      }
      if (sql.includes('SELECT dispatch."id" FROM "agent_outbox" AS dispatch')) {
        return response<T>(state.outbox.filter(item => String(item.id) === String(params[0]) && String(item.aggregateId) === String(params[1]) && String(item.topic) === String(params[2]) && item.publishedAt == null).map(item => ({ id: item.id })))
      }
      if (sql.includes('SELECT "id" FROM "agent_outbox"')) {
        return response<T>(state.outbox.filter(item => String(item.topic) === String(params[0]) && String(item.idempotencyKey) === String(params[1]) && String(item.aggregateId) === String(params[2])))
      }
      if (sql.includes('INSERT INTO "agent_outbox"')) {
        const sessionEvent = sql.includes("'agent.session.event'")
        const topic = sessionEvent ? "agent.session.event" : String(params[1])
        const aggregateId = sessionEvent ? String(params[1]) : String(params[2])
        const idempotencyKey = sessionEvent ? String(params[2]) : String(params[3])
        const payloadIndex = sessionEvent ? 3 : 4
        const payload = JSON.parse(String(params[payloadIndex])) as DurableCompositionRow
        const existingIndex = state.outbox.findIndex(item => String(item.idempotencyKey) === idempotencyKey)
        if (existingIndex >= 0) {
          if (topic === "agent.turn.dispatch") state.outbox[existingIndex] = { ...state.outbox[existingIndex], payload, publishedAt: null, attemptCount: Number(state.outbox[existingIndex]?.attemptCount ?? 0) + 1 }
          return response<T>([], sql.includes("DO UPDATE") ? 1 : 0)
        }
        state.outbox.push({ id: String(params[0]), topic, aggregateId, idempotencyKey, payload, publishedAt: null, attemptCount: 0 })
        return response<T>([], 1)
      }

      throw new Error(`Unexpected durable composition query: ${statement}`)
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn(async () => client) }, state }
}

describe("production Worker bootstrap", () => {
  it("drains the durable Turn dispatch through the bootstrap-owned queue and remains idempotent", async () => {
    const now = new Date("2026-09-22T00:00:00.000Z")
    const payload = { turnId: "turn_dispatch", sessionId: "session_dispatch", ownerId: "recovery_fixture" }
    let published = false
    const calls: string[] = []
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql)
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 1 }
        if (sql.includes("WITH candidates AS") || sql.includes("WITH stale")) return { rows: [], rowCount: 0 }
        if (sql.includes('FROM "agent_turns" AS turn') && sql.includes('LEFT JOIN "agent_outbox" AS dispatch')) return { rows: [], rowCount: 0 }
        if (sql.includes('SELECT dispatch."id", dispatch."aggregateId", dispatch."payload", dispatch."attemptCount"')) {
          return published ? { rows: [], rowCount: 0 } : { rows: [{ id: "dispatch_1", aggregateId: payload.sessionId, payload, attemptCount: 4 }], rowCount: 1 }
        }
        if (sql.includes('SELECT session."id" FROM "agent_sessions"')) return { rows: [{ id: payload.sessionId }], rowCount: 1 }
        if (sql.includes('SELECT dispatch."id" FROM "agent_outbox"')) return published ? { rows: [], rowCount: 0 } : { rows: [{ id: "dispatch_1" }], rowCount: 1 }
        if (sql.includes('SELECT turn."id"') && sql.includes("turnSession")) return { rows: [{ id: payload.turnId }], rowCount: 1 }
        if (sql.includes('UPDATE "agent_outbox"') && sql.includes('"publishedAt" = CURRENT_TIMESTAMP')) {
          published = true
          return { rows: [], rowCount: 1 }
        }
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    const pool = { connect: vi.fn(async () => client) }
    const add = vi.fn().mockResolvedValue(undefined)
    const events: string[] = []
    const canonical = runtime(events)
    const turnQueue = {
      queue: { add, close: vi.fn(async () => undefined) },
      worker: { pause: vi.fn(async () => undefined) },
      active: { size: 0, values: () => [] },
      close: vi.fn(async () => undefined),
    } as unknown as ReturnType<typeof createTurnQueue>
    const turnFactory = vi.fn(() => turnQueue) as unknown as Parameters<typeof createProductionWorkerBootstrap>[0]["turnQueueFactory"]
    const recoveryFactory = vi.fn((recoveryPool, queue) => {
      const first = recoverTurnQueue(recoveryPool, queue, "bootstrap-recovery", now)
      return {
        close: async () => {
          await first
          await recoverTurnQueue(recoveryPool, queue, "bootstrap-recovery", now)
        },
      }
    }) as unknown as Parameters<typeof createProductionWorkerBootstrap>[0]["turnRecoveryFactory"]

    const bootstrap = await createProductionWorkerBootstrap({
      pool: pool as never,
      runtime: canonical,
      turnQueueFactory: turnFactory,
      turnRecoveryFactory: recoveryFactory,
    })
    await bootstrap.close()

    expect(recoveryFactory).toHaveBeenCalledWith(pool, turnQueue.queue, undefined, undefined)
    expect(add).toHaveBeenCalledOnce()
    expect(add).toHaveBeenCalledWith("turn", payload, { jobId: turnJobId(payload.turnId, 4), attempts: 5 })
    expect(published).toBe(true)
    expect(calls.some(sql => sql.includes('UPDATE "agent_outbox"') && sql.includes('"publishedAt" = CURRENT_TIMESTAMP'))).toBe(true)
  })

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

  it("creates the canonical runtime inside the shared startup helper before consumers and router", async () => {
    let fixture: Awaited<ReturnType<typeof compositionRuntime>> | undefined
    let execute: CanonicalTurnRuntime["execute"] | undefined
    const startup: string[] = []
    const lease = {
      turnId: "turn_fixture", sessionId: "session_fixture", ownerId: "worker_fixture", userId: "user_fixture", leaseVersion: 1,
      leaseStartedAt: new Date("2026-09-01T00:00:00.000Z"), leaseExpiresAt: new Date("2026-09-01T00:10:00.000Z"),
    }
    const bootstrap = await startProductionAgentRuntime({
      pool: { connect: vi.fn() },
      createRuntime: async () => {
        startup.push("runtime-factory:start")
        const created = await compositionRuntime()
        fixture = created
        startup.push("runtime-factory:ready")
        return created.runtime
      },
      bootstrapOptions: {
        turnQueueFactory: vi.fn((options) => {
          startup.push("turn-consumer")
          execute = options.execute
          return { queue: { add: vi.fn() }, worker: {}, active: { size: 0, values: () => [] }, close: vi.fn(async () => undefined) } as never
        }) as unknown as Parameters<typeof createProductionWorkerBootstrap>[0]["turnQueueFactory"],
        turnRecoveryFactory: vi.fn(() => {
          startup.push("turn-recovery")
          return { close: vi.fn(async () => undefined) }
        }) as unknown as Parameters<typeof createProductionWorkerBootstrap>[0]["turnRecoveryFactory"],
      },
      onBootstrapReady: ready => { expect(ready.turns).toBeDefined(); startup.push("bootstrap-ready") },
      startAgentRunWorker: () => { startup.push("agent-run-router") },
    })

    expect(startup).toEqual(["runtime-factory:start", "runtime-factory:ready", "turn-consumer", "turn-recovery", "bootstrap-ready", "agent-run-router"])
    const composedFixture = fixture
    if (!composedFixture) throw new Error("canonical runtime fixture was not created")
    expect(execute).toBe(composedFixture.runtime.execute)
    const result = await execute!({ lease, signal: new AbortController().signal })

    expect(result).toMatchObject({ status: "completed" })
    expect(composedFixture.tool).toHaveBeenCalledWith(expect.objectContaining({ scope: { userId: "user_fixture" } }), {})
    expect(composedFixture.validatedArguments).toContainEqual({ name: "fixture.read", input: {}, version: "1" })
    expect(composedFixture.lifecycle.events.map((event) => event.phase)).toEqual(["started", "completed"])
    expect(composedFixture.requests).toHaveLength(2)
    expect(JSON.stringify(composedFixture.requests[1]?.messages)).toContain("fixture-call")
    expect(JSON.stringify(composedFixture.requests[1]?.messages)).toContain("user_fixture")
    expect(JSON.stringify(composedFixture.requests[1]?.messages)).toContain('"toolUseId":"fixture-call"')
    expect(JSON.stringify(composedFixture.requests[1]?.messages)).toContain('"content":"{\\"user\\":\\"user_fixture\\"}"')
    expect(composedFixture.persistedItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "tool_result", status: "completed",
        content: expect.objectContaining({ toolCallId: "fixture-call", output: { user: "user_fixture" } }),
      }),
    ]))
    expect(composedFixture.persistedEvents.some(event => event.type === "tool_call.completed" && JSON.stringify(event.payload).includes("fixture-call"))).toBe(true)
    await bootstrap.close()
    expect(composedFixture.manager.shutdown).toHaveBeenCalledOnce()
  })

  it("executes a model-proposed plan through production startup and continues on the next model step with bounded runtime evidence", async () => {
    const goalContract = {
      revision: 1, objective: "Read a bounded fixture result", constraints: [], successCriteria: [],
      knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "fixture-budget",
    }
    const proposal = {
      schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: 1, basedOnPlanRevision: null,
      nodes: [
        { localId: "search", kind: "use_tool", objective: "Read fixture evidence", inputRefs: [], dependsOn: [], successCriteria: ["Return fixture evidence"], outputSchemaRef: null, toolName: "jobs.search" },
        { localId: "finish", kind: "propose_completion", objective: "Finish after reading the result", inputRefs: [], dependsOn: ["search"], successCriteria: ["The read completed"], outputSchemaRef: null },
      ],
      completionCriteria: ["Read the fixture result"], briefRationale: "One deterministic read is sufficient.",
    }
    const boundedEvidence = "bounded-fixture-evidence-".repeat(280)
    const executedContexts: Array<{ scopeUserId: string; sessionId: string; turnId: string; taskId: string | null; rootTaskId: string | null; commandId: string | null }> = []
    const jobsSearch: RuntimeToolDefinition = {
      schemaVersion, name: "jobs.search", version: "1", description: "Read deterministic fixture evidence",
      capabilities: ["read"] as const, inputSchema: Type.Object({}, { additionalProperties: false }),
      outputSchema: Type.Object({ evidence: Type.String({ maxLength: 7_000 }), runtimeTaskId: Type.String(), runtimeCommandId: Type.String() }, { additionalProperties: false }),
      risk: "read" as const, domain: "jobs" as const, idempotency: "read_only" as const, timeoutMs: 1_000, requiredCapabilities: [] as const,
      execute: async context => {
        executedContexts.push({ scopeUserId: context.scope.userId, sessionId: context.sessionId, turnId: context.turnId, taskId: context.taskId ?? null, rootTaskId: context.rootTaskId ?? null, commandId: context.toolCallId ?? null })
        return { evidence: boundedEvidence, runtimeTaskId: context.taskId ?? "", runtimeCommandId: context.toolCallId ?? "" }
      },
    }
    const planner = createPlanProposalTool({
      goal: goalContract, allowedTools: ["jobs.search"], allowedTemplates: [], allowedRoles: [],
      allowedPlanActions: ["use_tool", "propose_completion"], maxNodes: 8,
    })
    const registry = new ToolRegistry([jobsSearch, planner as unknown as RuntimeToolDefinition])
    const validatedArguments: Array<{ name: string; input: unknown; version?: string }> = []
    vi.spyOn(registry, "validateArguments").mockImplementation((name, input, version) => {
      validatedArguments.push({ name, input, ...(version === undefined ? {} : { version }) })
      return ToolRegistry.prototype.validateArguments.call(registry, name, input, version)
    })
    const lifecycle = new InMemoryToolLifecycleSink()
    const requests: HarnessModelRequest[] = []
    const model: ModelAdapter = {
      id: "fixture-planner-model",
      profile: {
        provider: "fixture", model: "fixture-planner", nativeTools: true, structuredOutput: true, streaming: true,
        continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false,
        supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false,
        supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 256, costClass: "low",
      },
      async *stream(request: HarnessModelRequest): AsyncIterable<ModelStreamEvent> {
        requests.push(request)
        if (requests.length === 1) {
          yield { type: "tool_call_completed", callId: "proposal-call", name: "agent.plan.propose", arguments: { proposal } }
          yield { type: "completed", finishReason: "tool_calls" }
        } else {
          yield { type: "text_delta", text: "The bounded fixture result was read successfully." }
          yield { type: "completed", finishReason: "stop" }
        }
      },
    }
    const persistedItems: Array<{ type: string; status: string; content: unknown }> = []
    const persistedEvents: Array<{ type: string; payload: unknown }> = []
    const manager = { shutdown: vi.fn(async () => undefined) } as unknown as AgentTreeManager
    const state: CanonicalTurnState = {
      scope: { userId: "user_fixture" }, goal: goalContract.objective, goalContract, modelProfileSnapshot: {} as never,
      toolPolicySnapshot: { role: "orchestrator", capabilities: ["read"] }, budgetSnapshot: { limits: { maxSteps: 4, maxToolCalls: 4 } },
      snapshot: { system: [], profile: [], goal: { id: "goal_fixture", content: goalContract.objective }, steerHistory: [], businessRefs: [], toolObservations: [] },
    }
    const pool = { connect: vi.fn() }
    let execute: CanonicalTurnRuntime["execute"] | undefined
    const bootstrap = await startProductionAgentRuntime({
      pool,
      createRuntime: async () => createCanonicalTurnRuntime(pool as never, {
        workerId: "worker_fixture",
        productionFlags: {
          cognitiveLoopEnabled: false, planningEnabled: true, planningExecutionEnabled: true,
          childExecutionEnabled: false, coordinationEnabled: false, consumeWaitOutcomes: false,
          contextCompactionEnabled: false, canonicalAutomationEnabled: false,
        },
        manager,
        stateLoader: async () => state,
        modelRuntimeFactory: async () => ({ adapter: model, registry: {} as never, candidates: [] }),
        toolRuntimeFactory: ({ policy }) => ({ registry, router: new ToolRouter(registry, new ToolLifecycle({ sink: lifecycle, references: new InMemoryToolResultReferenceStore() }), policy) }),
        rootTaskStore: { ensure: vi.fn(async () => ({ id: "root_fixture" } as never)), finish: vi.fn(async () => undefined) },
        turnEngineStoreFactory: () => compositionStore(persistedItems, persistedEvents),
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
      }),
      bootstrapOptions: {
        turnQueueFactory: vi.fn(options => {
          execute = options.execute
          return { queue: { add: vi.fn() }, worker: {}, active: { size: 0, values: () => [] }, close: vi.fn(async () => undefined) } as never
        }) as unknown as Parameters<typeof createProductionWorkerBootstrap>[0]["turnQueueFactory"],
        turnRecoveryFactory: vi.fn(() => ({ close: vi.fn(async () => undefined) })) as unknown as Parameters<typeof createProductionWorkerBootstrap>[0]["turnRecoveryFactory"],
      },
      startAgentRunWorker: vi.fn(),
    })

    try {
      if (!execute) throw new Error("production bootstrap did not register its canonical turn executor")
      const result = await execute({
        lease: {
          turnId: "turn_fixture", sessionId: "session_fixture", ownerId: "worker_fixture", userId: "user_fixture", leaseVersion: 1,
          leaseStartedAt: new Date("2026-09-01T00:00:00.000Z"), leaseExpiresAt: new Date("2026-09-01T00:10:00.000Z"),
        },
        signal: new AbortController().signal,
      })

      expect(result).toMatchObject({ status: "completed" })
      expect(requests).toHaveLength(2)
      expect(validatedArguments).toContainEqual({ name: "agent.plan.propose", input: { proposal }, version: "1" })
      expect(executedContexts).toEqual([{
        scopeUserId: "user_fixture", sessionId: "session_fixture", turnId: "turn_fixture",
        taskId: "root_fixture", rootTaskId: "root_fixture", commandId: "plan-call:proposal-call:search",
      }])
      const taskGraphEvents = persistedEvents.filter(event => event.type === "plan.task_graph").map(event => event.payload as { runKey: string; event: { type: string; nodeId: string } })
      expect(taskGraphEvents.map(value => `${value.runKey}:${value.event.nodeId}:${value.event.type}`)).toEqual([
        "root_fixture:proposal-call:1:search:start",
        "root_fixture:proposal-call:1:search:complete",
        "root_fixture:proposal-call:1:finish:start",
        "root_fixture:proposal-call:1:finish:wait",
      ])
      const resultObservation = persistedEvents.find(event => event.type === "plan.observation" && (event.payload as { observationId?: string }).observationId === "plan-result:proposal-call:search")
      expect(resultObservation).toBeDefined()
      const observationPayload = resultObservation!.payload as { content: unknown }
      expect(observationPayload.content).toMatchObject({
        kind: "plan_command", localId: "search", commandKind: "tool_call", dependsOn: [], status: "completed", errorCode: null,
      })
      expect(new TextEncoder().encode(JSON.stringify(observationPayload.content)).byteLength).toBeLessThanOrEqual(8 * 1024)
      const completionObservation = persistedEvents.find(event => event.type === "plan.observation" && (event.payload as { observationId?: string }).observationId === "plan-control:proposal-call:finish")
      expect(completionObservation).toBeDefined()
      expect((completionObservation!.payload as { content: unknown }).content).toEqual({
        kind: "plan_control", localId: "finish", status: "completion_proposed", dependsOn: ["search"],
        completionCriteria: ["Read the fixture result", "The read completed"],
      })
      expect(persistedEvents.indexOf(resultObservation!)).toBeLessThan(persistedEvents.indexOf(completionObservation!))
      const resumedMessages = JSON.stringify(requests[1]?.messages)
      expect(resumedMessages).toContain("plan_command")
      expect(resumedMessages).toContain("completion_proposed")
      expect(resumedMessages).toContain("bounded-fixture-evidence")
      expect(resumedMessages).toContain("root_fixture")
      expect(resumedMessages).toContain("plan-call:proposal-call:search")
      expect(resumedMessages).toContain(boundedEvidence)
      expect(resumedMessages).not.toMatch(/\"(?:lease|leaseOwnerId|leaseVersion|budgetLimit|maxBudget)\"/)
    } finally {
      await bootstrap.close()
    }
    expect(manager.shutdown).toHaveBeenCalledOnce()
  })

  it("replans from a failed dependency and completion feedback through production startup", async () => {
    const goalContract = {
      revision: 1, objective: "Read a bounded fixture result", constraints: [], successCriteria: [],
      knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "fixture-budget",
    }
    const failedProposal = {
      schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: 1, basedOnPlanRevision: null,
      nodes: [
        { localId: "search", kind: "use_tool", objective: "Read fixture evidence", inputRefs: [], dependsOn: [], successCriteria: ["Return fixture evidence"], outputSchemaRef: null, toolName: "jobs.search" },
        { localId: "finish", kind: "propose_completion", objective: "Finish after reading the result", inputRefs: [], dependsOn: ["search"], successCriteria: ["The read completed"], outputSchemaRef: null },
      ],
      completionCriteria: ["Read the fixture result"], briefRationale: "Try the primary read first.",
    }
    const replacementProposal = {
      schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: 1, basedOnPlanRevision: 1,
      nodes: [
        { localId: "fallback", kind: "use_tool", objective: "Use the alternate read after primary failure", inputRefs: [], dependsOn: [], successCriteria: ["Return fallback evidence"], outputSchemaRef: null, toolName: "jobs.get" },
        { localId: "finish", kind: "propose_completion", objective: "Finish after the alternate read", inputRefs: [], dependsOn: ["fallback"], successCriteria: ["The fallback read completed"], outputSchemaRef: null },
      ],
      completionCriteria: ["Read the fixture result using an available source"], briefRationale: "The primary read failed; use a distinct read-only fallback.",
    }
    const jobsSearch: RuntimeToolDefinition = {
      schemaVersion, name: "jobs.search", version: "1", description: "Read deterministic fixture evidence",
      capabilities: ["read"] as const, inputSchema: Type.Object({}, { additionalProperties: false }),
      outputSchema: Type.Object({ evidence: Type.String() }, { additionalProperties: false }),
      risk: "read" as const, domain: "jobs" as const, idempotency: "read_only" as const, timeoutMs: 1_000, requiredCapabilities: [] as const,
      execute: async () => { throw new Error("fixture dependency failure") },
    }
    const fallbackContexts: Array<{ userId: string; sessionId: string; turnId: string; taskId: string | null; rootTaskId: string | null; toolCallId: string | null }> = []
    const jobsFallback: RuntimeToolDefinition = {
      schemaVersion, name: "jobs.get", version: "1", description: "Read alternate deterministic fixture evidence",
      capabilities: ["read"] as const, inputSchema: Type.Object({}, { additionalProperties: false }),
      outputSchema: Type.Object({ evidence: Type.String() }, { additionalProperties: false }),
      risk: "read" as const, domain: "jobs" as const, idempotency: "read_only" as const, timeoutMs: 1_000, requiredCapabilities: [] as const,
      execute: async context => {
        fallbackContexts.push({
          userId: context.scope.userId, sessionId: context.sessionId, turnId: context.turnId,
          taskId: context.taskId ?? null, rootTaskId: context.rootTaskId ?? null, toolCallId: context.toolCallId ?? null,
        })
        return { evidence: "fallback-fixture-evidence" }
      },
    }
    const planner = createPlanProposalTool({
      goal: goalContract, allowedTools: ["jobs.search", "jobs.get"], allowedTemplates: [], allowedRoles: [],
      allowedPlanActions: ["use_tool", "propose_completion"], maxNodes: 8,
    })
    const registry = new ToolRegistry([jobsSearch, jobsFallback, planner as unknown as RuntimeToolDefinition])
    const lifecycle = new InMemoryToolLifecycleSink()
    const requests: HarnessModelRequest[] = []
    const model: ModelAdapter = {
      id: "fixture-failing-planner-model",
      profile: {
        provider: "fixture", model: "fixture-planner", nativeTools: true, structuredOutput: true, streaming: true,
        continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false,
        supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false,
        supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 256, costClass: "low",
      },
      async *stream(request: HarnessModelRequest): AsyncIterable<ModelStreamEvent> {
        requests.push(request)
        if (requests.length === 1) {
          yield { type: "tool_call_completed", callId: "proposal-call", name: "agent.plan.propose", arguments: { proposal: failedProposal } }
          yield { type: "completed", finishReason: "tool_calls" }
        } else if (requests.length === 2) {
          yield { type: "text_delta", text: "The primary fixture read succeeded." }
          yield { type: "completed", finishReason: "stop" }
        } else if (requests.length === 3) {
          yield { type: "tool_call_completed", callId: "replacement-call", name: "agent.plan.propose", arguments: { proposal: replacementProposal } }
          yield { type: "completed", finishReason: "tool_calls" }
        } else {
          yield { type: "text_delta", text: "The alternate fixture read supplied the result." }
          yield { type: "completed", finishReason: "stop" }
        }
      },
    }
    const persistedItems: Array<{ type: string; status: string; content: unknown }> = []
    const persistedEvents: Array<{ type: string; payload: unknown }> = []
    const manager = { shutdown: vi.fn(async () => undefined) } as unknown as AgentTreeManager
    const state: CanonicalTurnState = {
      scope: { userId: "user_fixture" }, goal: goalContract.objective, goalContract, modelProfileSnapshot: {} as never,
      toolPolicySnapshot: { role: "orchestrator", capabilities: ["read"] }, budgetSnapshot: { limits: { maxSteps: 4, maxToolCalls: 4 } },
      snapshot: { system: [], profile: [], goal: { id: "goal_fixture", content: goalContract.objective }, steerHistory: [], businessRefs: [], toolObservations: [] },
    }
    const pool = { connect: vi.fn() }
    let execute: CanonicalTurnRuntime["execute"] | undefined
    const bootstrap = await startProductionAgentRuntime({
      pool,
      createRuntime: async () => createCanonicalTurnRuntime(pool as never, {
        workerId: "worker_fixture",
        productionFlags: {
          cognitiveLoopEnabled: false, planningEnabled: true, planningExecutionEnabled: true,
          childExecutionEnabled: false, coordinationEnabled: false, consumeWaitOutcomes: false,
          contextCompactionEnabled: false, canonicalAutomationEnabled: false,
        },
        manager, stateLoader: async () => state,
        modelRuntimeFactory: async () => ({ adapter: model, registry: {} as never, candidates: [] }),
        toolRuntimeFactory: ({ policy }) => ({ registry, router: new ToolRouter(registry, new ToolLifecycle({ sink: lifecycle, references: new InMemoryToolResultReferenceStore() }), policy) }),
        rootTaskStore: { ensure: vi.fn(async () => ({ id: "root_fixture" } as never)), finish: vi.fn(async () => undefined) },
        turnEngineStoreFactory: () => compositionStore(persistedItems, persistedEvents),
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
      }),
      bootstrapOptions: {
        turnQueueFactory: vi.fn(options => {
          execute = options.execute
          return { queue: { add: vi.fn() }, worker: {}, active: { size: 0, values: () => [] }, close: vi.fn(async () => undefined) } as never
        }) as unknown as Parameters<typeof createProductionWorkerBootstrap>[0]["turnQueueFactory"],
        turnRecoveryFactory: vi.fn(() => ({ close: vi.fn(async () => undefined) })) as unknown as Parameters<typeof createProductionWorkerBootstrap>[0]["turnRecoveryFactory"],
      },
      startAgentRunWorker: vi.fn(),
    })

    try {
      if (!execute) throw new Error("production bootstrap did not register its canonical turn executor")
      const result = await execute({
        lease: {
          turnId: "turn_fixture", sessionId: "session_fixture", ownerId: "worker_fixture", userId: "user_fixture", leaseVersion: 1,
          leaseStartedAt: new Date("2026-09-01T00:00:00.000Z"), leaseExpiresAt: new Date("2026-09-01T00:10:00.000Z"),
        },
        signal: new AbortController().signal,
      })

      expect(result).toMatchObject({ status: "completed" })
      expect(requests).toHaveLength(4)
      const failedDependency = persistedEvents.find(event => event.type === "plan.observation" && (event.payload as { observationId?: string }).observationId === "plan-result:proposal-call:search")
      expect(failedDependency).toBeDefined()
      expect((failedDependency!.payload as { content: unknown }).content).toMatchObject({ kind: "plan_command", localId: "search", status: "failed" })
      const firstRecoveryMessages = JSON.stringify(requests[1]?.messages)
      expect(firstRecoveryMessages).toContain("plan-result:proposal-call:search")
      expect(firstRecoveryMessages).toContain('\\"status\\":\\"failed\\"')
      const recoveryMessages = JSON.stringify(requests[2]?.messages)
      expect(recoveryMessages).toContain("plan-result:proposal-call:search")
      expect(recoveryMessages).toContain('\\"status\\":\\"failed\\"')
      expect(recoveryMessages).toContain("plan_completion_feedback")
      expect(recoveryMessages).toContain(PLAN_COMPLETION_FEEDBACK_TEXT)
      const completionFeedback = persistedEvents.find(event => event.type === "plan.completion_feedback")
      expect(completionFeedback).toBeDefined()
      const replacementRevision = persistedEvents.find(event => event.type === "plan.revision" && (event.payload as { planCallId?: string }).planCallId === "replacement-call")
      expect(replacementRevision).toMatchObject({ payload: { planCallId: "replacement-call", goalRevision: 1, planRevision: 2, basedOnPlanRevision: 1 } })
      const firstRevision = persistedEvents.find(event => event.type === "plan.revision" && (event.payload as { planCallId?: string }).planCallId === "proposal-call")
      expect((replacementRevision!.payload as { proposalHash?: string }).proposalHash).not.toBe((firstRevision!.payload as { proposalHash?: string }).proposalHash)
      expect(persistedEvents.indexOf(completionFeedback!)).toBeLessThan(persistedEvents.indexOf(replacementRevision!))
      const fallbackResult = persistedEvents.find(event => event.type === "plan.observation" && (event.payload as { observationId?: string }).observationId === "plan-result:replacement-call:fallback")
      expect(fallbackResult).toBeDefined()
      expect((fallbackResult!.payload as { content: unknown }).content).toMatchObject({ kind: "plan_command", localId: "fallback", status: "completed", output: { evidence: "fallback-fixture-evidence" } })
      expect(fallbackContexts).toEqual([{
        userId: "user_fixture", sessionId: "session_fixture", turnId: "turn_fixture",
        taskId: "root_fixture", rootTaskId: "root_fixture", toolCallId: "plan-call:replacement-call:fallback",
      }])
      const completion = persistedEvents.find(event => event.type === "plan.observation" && (event.payload as { observationId?: string }).observationId === "plan-control:replacement-call:finish")
      expect(completion).toBeDefined()
      expect((completion!.payload as { content: unknown }).content).toMatchObject({ kind: "plan_control", status: "completion_proposed", dependsOn: ["fallback"] })
      expect(persistedEvents.indexOf(fallbackResult!)).toBeLessThan(persistedEvents.indexOf(completion!))
      const finalMessages = JSON.stringify(requests[3]?.messages)
      expect(finalMessages).toContain("fallback-fixture-evidence")
      expect(finalMessages).toContain("completion_proposed")
      expect(persistedEvents.some(event => event.type === "turn.completed")).toBe(true)
    } finally {
      await bootstrap.close()
    }
    expect(manager.shutdown).toHaveBeenCalledOnce()
  })

  it("fails before starting the run router when enabled child execution is not wired", async () => {
    const events: string[] = []
    const canonical = { ...runtime(events), childExecutionEnabled: true }
    const startRouter = vi.fn()
    const turnQueueFactory = vi.fn()
    const bootstrapReady = vi.fn()

    await expect(startProductionAgentRuntime({
      pool: { connect: vi.fn() },
      createRuntime: async () => canonical,
      bootstrapOptions: { turnQueueFactory: turnQueueFactory as never },
      onBootstrapReady: bootstrapReady,
      startAgentRunWorker: startRouter,
    })).rejects.toThrow("canonical_child_execution_unconfigured")

    expect(turnQueueFactory).not.toHaveBeenCalled()
    expect(bootstrapReady).not.toHaveBeenCalled()
    expect(startRouter).not.toHaveBeenCalled()
    expect(events).toEqual(["runtime.close"])
  })

  it("composes root TurnEngine coordination with two leased child executions and wait closure", async () => {
    const now = new Date("2026-09-01T00:00:00.000Z")
    const childA: SubagentTaskRecord = { id: "child_fixture_a", userId: "user_fixture", sessionId: "session_fixture", turnId: "turn_fixture", rootTaskId: "root_fixture", parentTaskId: "root_fixture", path: "/root_fixture/child_fixture_a", depth: 1, role: "scout", taskType: "research", status: "queued", goal: "Find scout evidence", constraints: [], successCriteria: [], allowedActions: ["fixture.read"], context: { privateMarker: "child-a-private-marker" }, expectedOutputSchema: null, result: null, failureReason: null, attemptCount: 0, maxAttempts: 3, nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null, budgetSnapshot: { limits: { maxSteps: 4 }, subagentPolicy: { maxAttempts: 3 } }, toolPolicySnapshot: { capabilities: ["read"] } }
    const childB: SubagentTaskRecord = { ...childA, id: "child_fixture_b", path: "/root_fixture/child_fixture_b", role: "analyst", goal: "Find analyst evidence", context: { privateMarker: "child-b-private-marker" } }
    const childBySpawnKey = new Map([["spawn_fixture_a", childA], ["spawn_fixture_b", childB]])
    const rootTask: SubagentTaskRecord = { ...childA, id: "root_fixture", parentTaskId: null, path: "/root_fixture", depth: 0, role: "orchestrator", taskType: "turn", status: "running" }
    const tasks = new Map<string, SubagentTaskRecord>()
    const clock: SubagentClock = { setInterval: () => 1 as never, clearInterval: vi.fn() }
    const store: SubagentStore = { async create() { throw new Error("non_atomic") }, async createWithSpawn(input) { const template = childBySpawnKey.get(input.spawnIdempotencyKey); if (!template) throw new Error(`unexpected_spawn:${input.spawnIdempotencyKey}`); const task = { ...template, userId: input.userId, sessionId: input.sessionId, turnId: input.turnId ?? null, role: input.role, taskType: input.taskType, goal: input.goal, context: input.context, allowedActions: input.allowedActions ?? template.allowedActions }; tasks.set(task.id, task); return { task, duplicate: false } }, async get(id) { return id === rootTask.id ? rootTask : tasks.get(id) ?? null }, async claim(input) { const value = tasks.get(input.taskId); if (!value || value.status !== "queued") return null; const leased = { ...value, status: "running" as const, attemptCount: 1, leaseOwner: input.ownerId, leaseExpiresAt: new Date(now.getTime() + 60_000) }; tasks.set(value.id, leased); return leased }, async heartbeat() { return "renewed" }, async finish(input) { const value = tasks.get(input.taskId); if (!value || value.leaseOwner !== input.ownerId) return null; tasks.set(value.id, { ...value, status: input.status, result: input.result ?? null }); return input.status }, async close() { return false }, async interruptTree() { return 0 }, async recoverExpired() { return [] } }
    const manager = new AgentTreeManager(store, { now: () => now, clock })
    const rootView: CoordinationTaskView = { ...childA, id: "root_fixture", parentTaskId: null, path: "/root_fixture", depth: 0, role: "orchestrator", taskType: "turn", status: "running" }
    const view = (id: string): CoordinationTaskView => ({ ...tasks.get(id)! })
    const replays = new Map<string, CoordinationTaskView>()
    const coordinationStore: CoordinationStore = { getTask: async input => input.taskId === "root_fixture" ? rootView : view(input.taskId), listTasks: async () => [...tasks.keys()].map(view), sendMessage: vi.fn(), getSpawnReplay: async input => replays.get(input.idempotencyKey) ?? null, recordSpawn: async input => { replays.set(input.idempotencyKey, input.task); return true }, appendActivity: async () => undefined }
    const childRequests = new Map<string, HarnessModelRequest[]>()
    const childToolCalls: Array<{ context: ToolRouterContext; request: ToolCallRequest }> = []
    const childCallsByTask = new Map<string, number>()
    const childTool = vi.fn(async (taskId: string) => ({ child: taskId, evidence: `job-${taskId}` }))
    const childDefinition: PublicToolDefinition = { schemaVersion, name: "fixture.read", version: "1", description: "Read deterministic child evidence", capabilities: ["read"], inputSchema: Type.Object({}, { additionalProperties: false }), outputSchema: Type.Object({ child: Type.String(), evidence: Type.String() }, { additionalProperties: false }), risk: "read", domain: "jobs", idempotency: "read_only", timeoutMs: 1_000, requiredCapabilities: [] }
    const childRouter = vi.fn(async (context: ToolRouterContext, request: ToolCallRequest) => {
      childToolCalls.push({ context, request })
      return { id: request.id, toolName: request.toolName, toolVersion: request.toolVersion, status: "completed" as const, output: await childTool(context.taskId!), errorCode: null }
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
    const childModelRuntimeFactory = vi.fn(({ task }: { task: SubagentTaskRecord }): ModelAdapter => {
      const requestsForTask: HarnessModelRequest[] = []
      childRequests.set(task.id, requestsForTask)
      childCallsByTask.set(task.id, 0)
      return {
        id: `fixture-child-model-${task.id}`,
        profile: { provider: "fixture", model: `fixture-child-${task.id}`, nativeTools: true, structuredOutput: true, streaming: true, continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false, supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false, supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 128, costClass: "low" },
        async *stream(request) {
          requestsForTask.push(request)
          const calls = (childCallsByTask.get(task.id) ?? 0) + 1
          childCallsByTask.set(task.id, calls)
          if (calls === 1) yield* [{ type: "tool_call_completed", callId: `child-read-${task.id}`, name: "fixture.read", arguments: {} }, { type: "completed", finishReason: "tool_calls" }]
          else yield* [{ type: "text_delta", text: `Child ${task.id} found job-${task.id}.` }, { type: "completed", finishReason: "stop" }]
        },
      }
    })
    const childOwners: ExecutionOwnerFence[] = []
    const childToolRuntimeFactory = vi.fn(({ task, lease, owner }: { task: SubagentTaskRecord; lease: SubagentLease; owner: ExecutionOwnerFence }) => {
      childOwners.push(owner)
      expect(task.id).toMatch(/^child_fixture_[ab]$/)
      expect(lease.id).toBe(task.id)
      expect(owner).toMatchObject({ userId: "user_fixture", sessionId: "session_fixture", turnId: "turn_fixture", taskId: task.id, rootTaskId: "root_fixture", ownerId: `queue_${task.id.slice(-1)}`, attemptCount: 1 })
      return {
        definitions: [childDefinition], router: { execute: childRouter },
        validateArguments: (name: string, input: unknown, version?: string): true | string => {
          if (name !== childDefinition.name || (version !== undefined && version !== childDefinition.version)) return "unknown fixture tool"
          if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 0) return "invalid fixture arguments"
          return true
        },
      }
    })
    const childExecutor = createProductionChildExecutor({
      pool: { connect: vi.fn() } as never,
      turnStore: childTurnStore,
      treeBudget: childBudget,
      authorizeUsage: vi.fn(async () => ({ settle: vi.fn(async () => undefined) })),
      modelRuntimeFactory: childModelRuntimeFactory,
      toolRuntimeFactory: childToolRuntimeFactory,
    })
    const durableFixture = durableCompositionPool({ root: rootTask, tasks, now })
    durableFixture.state.turn.status = "queued"
    durableFixture.state.turn.leaseOwnerId = null
    durableFixture.state.turn.leaseVersion = 0
    durableFixture.state.turn.leaseStartedAt = null
    durableFixture.state.turn.leaseExpiresAt = null
    durableFixture.state.outbox.push({ id: "dispatch-initial", topic: "agent.turn.dispatch", aggregateId: "session_fixture", idempotencyKey: "turn-dispatch:turn_fixture", payload: { turnId: "turn_fixture", sessionId: "session_fixture", ownerId: "worker_fixture" }, publishedAt: null, attemptCount: 0 })
    const durableWait = createPgDurableWaitPort(durableFixture.pool as never)
    let bootstrappedChildExecutor: ((input: { lease: SubagentLease }) => Promise<SubagentExecutionResult>) | undefined
    let waitCalls = 0
    const wait: DurableWaitPort = { wait: async input => {
      waitCalls += 1
      return durableWait.wait(input)
    } }
    const requests: HarnessModelRequest[] = []
    let calls = 0
    const model: ModelAdapter = {
      id: "fixture-model",
      profile: { provider: "fixture", model: "fixture", nativeTools: true, structuredOutput: true, streaming: true, continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false, supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false, supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 128, costClass: "low" },
      async *stream(request) {
        requests.push(request)
        calls += 1
        if (calls === 1) yield* [{ type: "tool_call_completed", callId: "spawn-a", name: "agent.spawn", arguments: { idempotencyKey: "spawn_fixture_a", role: "scout", taskType: "research", goal: "Find scout evidence", allowedActions: ["fixture.read"], context: { privateMarker: "child-a-private-marker" } } }, { type: "completed", finishReason: "tool_calls" }]
        else if (calls === 2) yield* [{ type: "tool_call_completed", callId: "spawn-b", name: "agent.spawn", arguments: { idempotencyKey: "spawn_fixture_b", role: "analyst", taskType: "research", goal: "Find analyst evidence", allowedActions: ["fixture.read"], context: { privateMarker: "child-b-private-marker" } } }, { type: "completed", finishReason: "tool_calls" }]
        else if (calls === 3) yield* [{ type: "tool_call_completed", callId: "wait", name: "agent.wait", arguments: { idempotencyKey: "wait_fixture", taskIds: [childA.id, childB.id], mode: "all", timeoutMs: 1_000 } }, { type: "completed", finishReason: "tool_calls" }]
        else if (calls === 4) yield* [{ type: "tool_call_completed", callId: "read", name: "fixture.read", arguments: {} }, { type: "completed", finishReason: "tool_calls" }]
        else yield* [{ type: "text_delta", text: "Found both child results." }, { type: "completed", finishReason: "stop" }]
      },
    }
    const resumeRequests: HarnessModelRequest[] = []
    let resumeModelCalls = 0
    const resumedModel: ModelAdapter = {
      id: "fixture-model-restarted",
      profile: model.profile,
      async *stream(request) {
        resumeRequests.push(request)
        resumeModelCalls += 1
        if (resumeModelCalls === 1) yield* [{ type: "tool_call_completed", callId: "read-resumed", name: "fixture.read", arguments: {} }, { type: "completed", finishReason: "tool_calls" }]
        else yield* [{ type: "text_delta", text: "Found both child results after recovery." }, { type: "completed", finishReason: "stop" }]
      },
    }
    const parentPrivateObservation: CanonicalTurnState["snapshot"]["toolObservations"] = [{ id: "root-private", content: "parent-private-marker" }]
    const fixture = await coordinationRuntime({ manager, store: coordinationStore, wait, model, stateLoader: state => ({ ...state, snapshot: { ...state.snapshot, toolObservations: parentPrivateObservation } }) })
    let execute: CanonicalTurnRuntime["execute"] | undefined
    let waitHandoff: Parameters<typeof createTurnQueue>[0]["waitHandoff"] | undefined
    const childQueueFactory = vi.fn(options => {
      bootstrappedChildExecutor = options.execute as typeof childExecutor
      return { queue: { add: vi.fn() }, worker: {}, close: vi.fn(async () => undefined) } as never
    })
    const waitResolverFactory = vi.fn((pool: Parameters<typeof startDurableWaitResolver>[0], options: Parameters<typeof startDurableWaitResolver>[1]) => startDurableWaitResolver(pool, options))
    const bootstrap = await createProductionWorkerBootstrap({
      pool: durableFixture.pool as never,
      runtime: fixture.runtime,
      turnQueueFactory: vi.fn(options => {
        execute = options.execute
        waitHandoff = options.waitHandoff
        return { queue: { add: vi.fn() }, worker: {}, active: { size: 0, values: () => [] }, close: vi.fn(async () => undefined) } as never
      }) as never,
      turnRecoveryFactory: vi.fn(() => ({ close: vi.fn(async () => undefined) })) as never,
      waitResolver: { intervalMs: 60_000, batchSize: 1 },
      waitResolverFactory: waitResolverFactory as never,
      subagents: {
        execute: childExecutor,
        queueFactory: childQueueFactory as never,
        recoveryFactory: vi.fn(() => ({ close: vi.fn(async () => undefined) })) as never,
      },
    })
    expect(bootstrap.subagents).toBeDefined()
    expect(bootstrap.waitResolver).toBeDefined()
    expect(childQueueFactory).toHaveBeenCalledWith(expect.objectContaining({ execute: childExecutor, manager }))
    expect(waitResolverFactory).toHaveBeenCalledOnce()
    expect(waitResolverFactory.mock.calls[0]?.[1]).toEqual({ intervalMs: 60_000, batchSize: 1 })
    try {
      expect(waitHandoff).toBeDefined()
      const firstLease: TurnLease = { turnId: "turn_fixture", sessionId: "session_fixture", ownerId: "worker_fixture", userId: "user_fixture", leaseVersion: 1, leaseStartedAt: now, leaseExpiresAt: new Date(now.getTime() + 60_000) }
      const parentExecutor: TurnExecutor = async input => {
        const result = await execute!({ lease: input.lease, signal: input.signal })
        return result.status === "waiting_for_dependency" && durableFixture.state.wait ? { ...result, waitId: String(durableFixture.state.wait.id) } : result
      }
      const waiting = await runTurnJob({ data: { turnId: "turn_fixture", sessionId: "session_fixture", ownerId: "worker_fixture" }, attemptsMade: 0 }, { pool: durableFixture.pool as never, execute: parentExecutor, waitHandoff: waitHandoff!, now: () => now, heartbeatMs: 60_000 })
      expect(waiting).toMatchObject({ status: "waiting_for_dependency" })
      expect(waitCalls).toBe(1)
      expect(durableFixture.state.wait).toMatchObject({ status: "waiting", targetTaskIds: [childA.id, childB.id] })
      expect(durableFixture.state.turn.leaseVersion).toBe(1)

      const waitId = String(durableFixture.state.wait?.id)
      expect(durableFixture.state.wait).toMatchObject({ status: "waiting", suspendedAt: now })
      expect(durableFixture.state.turn).toMatchObject({ status: "waiting_for_dependency", leaseOwnerId: null })

      expect(bootstrappedChildExecutor).toBe(childExecutor)
      const childOutcomes = await Promise.all([
        manager.run({ taskId: childA.id, sessionId: "session_fixture", rootTaskId: "root_fixture", ownerId: "queue_a" }, bootstrappedChildExecutor!),
        manager.run({ taskId: childB.id, sessionId: "session_fixture", rootTaskId: "root_fixture", ownerId: "queue_b" }, bootstrappedChildExecutor!),
      ])
      expect(childOutcomes).toEqual([
        expect.objectContaining({ taskId: childA.id, status: "completed" }),
        expect.objectContaining({ taskId: childB.id, status: "completed" }),
      ])
      expect(tasks.get(childA.id)?.result).toMatchObject({ status: "completed", toolCallCount: 1, finalText: `Child ${childA.id} found job-${childA.id}.` })
      expect(tasks.get(childB.id)?.result).toMatchObject({ status: "completed", toolCallCount: 1, finalText: `Child ${childB.id} found job-${childB.id}.` })

      await expect(reconcileDurableWaits(durableFixture.pool as never, { now: new Date(now.getTime() + 1_000), ownerId: "worker_recovery" })).resolves.toEqual({ scanned: 1, resolved: 1, woken: 1 })
      expect(durableFixture.state.wait).toMatchObject({ status: "ready", matchedTaskIds: [childA.id, childB.id] })
      expect(durableFixture.state.turn).toMatchObject({ status: "queued", leaseOwnerId: null })
      expect(durableFixture.state.events).toHaveLength(1)
      expect(durableFixture.state.outbox.filter(item => item.topic === "agent.session.event")).toHaveLength(1)
      expect(durableFixture.state.outbox.filter(item => item.topic === "agent.turn.dispatch")).toHaveLength(1)

      await expect(reconcileDurableWaits(durableFixture.pool as never, { now: new Date(now.getTime() + 2_000), ownerId: "worker_recovery" })).resolves.toEqual({ scanned: 0, resolved: 0, woken: 0 })
      await expect(durableWait.suspendAndRelease({ lease: firstLease, waitId, now })).resolves.toMatchObject({ handoff: "queued", idempotent: true })
      expect(durableFixture.state.events).toHaveLength(1)
      expect(durableFixture.state.outbox.filter(item => item.topic === "agent.session.event")).toHaveLength(1)
      expect(durableFixture.state.outbox.filter(item => item.topic === "agent.turn.dispatch")).toHaveLength(1)

      await expect(durableWait.wait({ userId: "user_fixture", sessionId: "session_fixture", turnId: "turn_fixture", stepId: String(durableFixture.state.wait?.stepId), taskId: "root_fixture", rootTaskId: "root_fixture", targetTaskIds: [childA.id, childB.id], mode: "all", timeoutMs: 1_000, idempotencyKey: "wait_fixture" })).resolves.toMatchObject({ status: "ready", matchedTaskIds: [childA.id, childB.id] })

      expect(durableFixture.state.turn.status).toBe("queued")
      await bootstrap.close()

      const recoveryNow = new Date(now.getTime() + 3_000)
      const restartedManager = new AgentTreeManager(store, { now: () => recoveryNow, clock })
      const restartedFixture = await coordinationRuntime({
        workerId: "worker_recovery",
        manager: restartedManager,
        store: coordinationStore,
        wait,
        model: resumedModel,
        pool: durableFixture.pool as never,
        now: () => recoveryNow,
        consumeWaitOutcomes: true,
      })
      type RecoveredTurnPayload = Parameters<typeof runTurnJob>[0]["data"]
      const recoveredJobs: Array<{ name: string; data: RecoveredTurnPayload; options?: { jobId?: string; attempts?: number } }> = []
      const addRecoveredJob = vi.fn(async (name: string, data: RecoveredTurnPayload, options?: { jobId?: string; attempts?: number }) => {
        recoveredJobs.push({ name, data, options })
      })
      let resumedExecute: CanonicalTurnRuntime["execute"] | undefined
      let recoveryScan: ReturnType<typeof recoverTurnQueue> | undefined
      const restartedBootstrap = await createProductionWorkerBootstrap({
        pool: durableFixture.pool as never,
        ownerId: "worker_recovery",
        runtime: restartedFixture.runtime,
        turnQueueFactory: vi.fn(options => {
          resumedExecute = options.execute
          return { queue: { add: addRecoveredJob }, worker: { pause: vi.fn(async () => undefined) }, active: { size: 0, values: () => [] }, close: vi.fn(async () => undefined) } as never
        }) as never,
        turnRecoveryFactory: vi.fn((recoveryPool, queue, ownerId) => {
          recoveryScan = recoverTurnQueue(recoveryPool, queue, ownerId, recoveryNow)
          return { close: async () => { await recoveryScan } }
        }) as never,
        waitResolver: { intervalMs: 60_000, batchSize: 1 },
        waitResolverFactory: waitResolverFactory as never,
        subagents: {
          execute: childExecutor,
          queueFactory: childQueueFactory as never,
          recoveryFactory: vi.fn(() => ({ close: vi.fn(async () => undefined) })) as never,
        },
      })
      try {
        expect(restartedBootstrap.runtime).toBe(restartedFixture.runtime)
        expect(restartedBootstrap.runtime).not.toBe(bootstrap.runtime)
        expect(restartedManager).not.toBe(manager)
        expect(childQueueFactory).toHaveBeenCalledWith(expect.objectContaining({ execute: childExecutor, manager: restartedManager }))
        expect(recoveryScan).toBeDefined()
        await expect(recoveryScan!).resolves.toEqual({ reclaimed: 0, repaired: 0, dispatched: 1 })
        expect(recoveredJobs).toHaveLength(1)
        expect(recoveredJobs[0]).toMatchObject({
          name: "turn",
          data: { turnId: "turn_fixture", sessionId: "session_fixture", ownerId: "worker_recovery" },
          options: { attempts: 5 },
        })
        expect(durableFixture.state.outbox.find(item => item.topic === "agent.turn.dispatch")).toMatchObject({ publishedAt: expect.any(Date) })

        const recovered = recoveredJobs[0]!
        const resumed = await runTurnJob({ data: recovered.data, attemptsMade: 0 }, { pool: durableFixture.pool as never, execute: resumedExecute!, now: () => recoveryNow, heartbeatMs: 60_000 })
        expect(resumed).toMatchObject({ status: "completed" })
        expect(durableFixture.state.wait?.consumedAt).toEqual(recoveryNow)
        expect(durableFixture.state.calls.filter(sql => sql.includes('SET "result" = jsonb_set'))).toHaveLength(1)
        expect(durableFixture.state.calls.some(sql => sql.includes('FROM "agent_turns" WHERE "id" = $1') && sql.includes("FOR UPDATE"))).toBe(true)
        expect(durableFixture.state.calls.some(sql => sql.includes('FROM "agent_wait_conditions"') && sql.includes('"parentTaskId" = $4') && sql.includes('"status" IN (\'ready\', \'timed_out\')'))).toBe(true)
        expect(durableFixture.state.turn).toMatchObject({ status: "completed", leaseOwnerId: null, leaseVersion: 2 })
        const resumedMessages = JSON.stringify(resumeRequests[0]?.messages).replaceAll('\\"', '"')
        expect(resumedMessages).toContain(String(durableFixture.state.wait?.id))
        expect(resumedMessages).toContain('"status":"ready"')
        expect(resumedMessages).toContain(`Child ${childA.id} found job-${childA.id}.`)
        expect(resumedMessages).toContain(`Child ${childB.id} found job-${childB.id}.`)
        expect(resumeRequests).toHaveLength(2)
      } finally {
        await restartedBootstrap.close()
      }

      expect(waitCalls).toBe(1)
      expect(childModelRuntimeFactory).toHaveBeenCalledTimes(2)
      expect(childToolRuntimeFactory).toHaveBeenCalledTimes(2)
      expect(childOwners.map(({ userId, sessionId, turnId, taskId, rootTaskId, ownerId }) => ({ userId, sessionId, turnId, taskId, rootTaskId, ownerId })).sort((left, right) => left.taskId.localeCompare(right.taskId))).toEqual([
        { userId: "user_fixture", sessionId: "session_fixture", turnId: "turn_fixture", taskId: childA.id, rootTaskId: "root_fixture", ownerId: "queue_a" },
        { userId: "user_fixture", sessionId: "session_fixture", turnId: "turn_fixture", taskId: childB.id, rootTaskId: "root_fixture", ownerId: "queue_b" },
      ])
      expect(childRequests.get(childA.id)).toHaveLength(2)
      expect(childRequests.get(childB.id)).toHaveLength(2)
      expect(childRequests.get(childA.id)?.[0]?.tools).toEqual([expect.objectContaining({ name: "fixture.read" })])
      expect(childRequests.get(childB.id)?.[0]?.tools).toEqual([expect.objectContaining({ name: "fixture.read" })])
      expect(childTool).toHaveBeenCalledTimes(2)
      expect(childTool.mock.calls.map(([taskId]) => taskId).sort()).toEqual([childA.id, childB.id])
      expect(childToolCalls).toHaveLength(2)
      expect(childToolCalls.map(call => call.context.taskId).sort()).toEqual([childA.id, childB.id])
      for (const call of childToolCalls) {
        expect(call.context).toMatchObject({ scope: { userId: "user_fixture" }, sessionId: "session_fixture", turnId: "turn_fixture", rootTaskId: "root_fixture", actorRole: "subagent" })
      }
      const childARequestJson = JSON.stringify(childRequests.get(childA.id))
      const childBRequestJson = JSON.stringify(childRequests.get(childB.id))
      expect(JSON.stringify(childRequests.get(childA.id)?.[1]?.messages)).toContain(`job-${childA.id}`)
      expect(JSON.stringify(childRequests.get(childA.id)?.[1]?.messages)).not.toContain(`job-${childB.id}`)
      expect(JSON.stringify(childRequests.get(childB.id)?.[1]?.messages)).toContain(`job-${childB.id}`)
      expect(JSON.stringify(childRequests.get(childB.id)?.[1]?.messages)).not.toContain(`job-${childA.id}`)
      expect(childARequestJson).toContain("child-a-private-marker")
      expect(childARequestJson).not.toContain("child-b-private-marker")
      expect(childARequestJson).not.toContain("parent-private-marker")
      expect(childBRequestJson).toContain("child-b-private-marker")
      expect(childBRequestJson).not.toContain("child-a-private-marker")
      expect(childBRequestJson).not.toContain("parent-private-marker")
      expect(JSON.stringify(requests[0]?.messages)).toContain("parent-private-marker")
      expect(childBudget.reserve).toHaveBeenCalledTimes(4)
      expect(childBudget.settle).toHaveBeenCalledTimes(4)
      expect(childBudgetReservations.every(reservation => reservation.status === "consumed")).toBe(true)
      expect(new Set(childBudgetReservations.map(reservation => reservation.idempotencyKey)).size).toBe(4)
      expect(new Set(childBudgetReservations.map(reservation => reservation.taskId))).toEqual(new Set([childA.id, childB.id]))
      expect(childBudgetReservations.every(reservation => reservation.userId === "user_fixture" && reservation.sessionId === "session_fixture" && reservation.turnId === "turn_fixture" && reservation.rootTaskId === "root_fixture" && reservation.attempt === 1)).toBe(true)
      expect(requests).toHaveLength(3)
    } finally {
      await bootstrap.close()
      vi.useRealTimers()
    }
  })
})
