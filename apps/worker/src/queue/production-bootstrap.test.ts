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
import { createPgDurableWaitPort } from "../runtime/subagents/durable-wait-store.js"
import { reconcileDurableWaits, startDurableWaitResolver } from "../runtime/subagents/durable-wait-resolver.js"
import { consumeDurableWaitOutcomes } from "../runtime/subagents/durable-wait-consumer.js"
import type { createSubagentQueue } from "./subagent-queue.js"
import { runTurnJob, type createTurnQueue, type TurnExecutor } from "../runtime/turns/turn-queue.js"
import type { TurnLease } from "../runtime/turns/lease.js"
import { recoverTurnQueue, turnJobId } from "../runtime/turns/recovery-scanner.js"
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

async function coordinationRuntime(input: { manager: AgentTreeManager; store: CoordinationStore; wait: DurableWaitPort; model: ModelAdapter; stateLoader?: (state: CanonicalTurnState) => CanonicalTurnState | Promise<CanonicalTurnState> }): Promise<{ runtime: CanonicalTurnRuntime; execute: CanonicalTurnRuntime["execute"] }> {
  const read: RuntimeToolDefinition = { schemaVersion, name: "fixture.read", version: "1", description: "Read fixture evidence", capabilities: ["read"], inputSchema: Type.Object({}, { additionalProperties: false }), outputSchema: Type.Object({ jobs: Type.Array(Type.Object({ id: Type.String() }, { additionalProperties: false })) }, { additionalProperties: false }), risk: "read", domain: "jobs", idempotency: "read_only", timeoutMs: 1_000, requiredCapabilities: [], execute: async () => ({ jobs: [{ id: "job-fixture" }] }) }
  const registry = new ToolRegistry([read, ...createCoordinationTools({ manager: input.manager, store: input.store, wait: input.wait })])
  const router = new ToolRouter(registry, new ToolLifecycle({ sink: new InMemoryToolLifecycleSink(), references: new InMemoryToolResultReferenceStore() }), createCanonicalPolicy(undefined, true, false))
  const state: CanonicalTurnState = { scope: { userId: "user_fixture" }, goal: "Read fixture state", modelProfileSnapshot: {} as never, toolPolicySnapshot: { role: "orchestrator", capabilities: ["read", "coordination"] }, budgetSnapshot: { limits: { maxSteps: 5 } }, snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] } }
  const runtime = await createCanonicalTurnRuntime({ connect: vi.fn() } as never, { workerId: "worker_fixture", manager: input.manager, coordinationEnabled: true, stateLoader: async () => input.stateLoader ? input.stateLoader(state) : state, modelRuntimeFactory: async () => ({ adapter: input.model, registry: {} as never, candidates: [] }), toolRuntimeFactory: () => ({ registry, router }), rootTaskStore: { ensure: vi.fn(async () => ({ id: "root_fixture" } as never)), finish: vi.fn(async () => undefined) }, turnEngineStoreFactory: () => compositionStore(), contextBuilderFactory: () => new StepContextBuilder({ scope: { userId: "user_fixture" }, withTransaction: async work => work({ getCheckpoint: async () => ({ inputThroughSequence: 0n, consumedInputIds: [] }), claimInputs: async () => ({ inputs: [], newlyClaimedInputIds: [] }), persistCheckpoint: async () => undefined }) } satisfies InputClaimStore), authorizeUsage: vi.fn(async () => ({ settle: vi.fn(async () => undefined) })) })
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
    step: { id: "step_pending", taskId: input.root.id, turnId: input.root.turnId, sessionId: input.root.sessionId, attempt: 1, status: "waiting_for_tool" },
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
      if (sql.includes('SELECT session."id", session."userId", session."status"')) {
        return response<T>(state.session.status === "running" ? [{ ...state.session }] : [], state.session.status === "running" ? 1 : 0)
      }
      if (sql.includes('UPDATE "agent_sessions"')) {
        state.session.eventSequence += 1
        return response<T>([{ eventSequence: String(state.session.eventSequence) }], 1)
      }

      if (sql.includes('FROM "agent_wait_conditions"')) {
        const current = waitRow()
        if (!current) return response<T>([])
        if (sql.includes('"turnId" = $3')) {
          return response<T>(String(params[2]) === state.turn.id && String(current.status) !== "closed" && current.consumedAt == null ? [current] : [])
        }
        if (String(params[0]) === String(current.id) || (String(params[0]) === input.root.id && String(params[1]) === String(current.idempotencyKey))) return response<T>([current])
        return response<T>([])
      }

      if (sql.includes('FROM "agent_steps"')) {
        if (typeof params[0] === "string") state.step.id = params[0]
        return response<T>([{ ...state.step }])
      }

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
    let parentResuming = false
    let resumeObservation: CanonicalTurnState["snapshot"]["toolObservations"] = []
    const wait: DurableWaitPort = { wait: async input => {
      waitCalls += 1
      return durableWait.wait(input)
    } }
    const requests: HarnessModelRequest[] = []
    let calls = 0
    const model: ModelAdapter = { id: "fixture-model", profile: { provider: "fixture", model: "fixture", nativeTools: true, structuredOutput: true, streaming: true, continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false, supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false, supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 128, costClass: "low" }, async *stream(request) { requests.push(request); calls += 1; if (calls === 1) yield* [{ type: "tool_call_completed", callId: "spawn", name: "agent.spawn", arguments: { idempotencyKey: "spawn_fixture", role: "scout", taskType: "research", goal: "Find fixture evidence" } }, { type: "completed", finishReason: "tool_calls" }]; else if (calls === 2) yield* [{ type: "tool_call_completed", callId: "wait", name: "agent.wait", arguments: { idempotencyKey: "wait_fixture", taskIds: [child.id], mode: "all", timeoutMs: 1_000 } }, { type: "completed", finishReason: "tool_calls" }]; else if (calls === 3) yield* [{ type: "tool_call_completed", callId: "read", name: "fixture.read", arguments: {} }, { type: "completed", finishReason: "tool_calls" }]; else yield* [{ type: "text_delta", text: "Found job-fixture." }, { type: "completed", finishReason: "stop" }] } }
    const fixture = await coordinationRuntime({ manager, store: coordinationStore, wait, model, stateLoader: state => parentResuming ? { ...state, snapshot: { ...state.snapshot, toolObservations: resumeObservation } } : state })
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
      let resumeProjection: Awaited<ReturnType<typeof consumeDurableWaitOutcomes>> = []
      let projectionCalls = 0
      const parentExecutor: TurnExecutor = async input => {
        if (input.lease.ownerId === "worker_resume") {
          projectionCalls += 1
          const client = await durableFixture.pool.connect()
          try {
            resumeProjection = [...await consumeDurableWaitOutcomes({ client: client as never, lease: input.lease, turn: { ...durableFixture.state.turn }, now: new Date(now.getTime() + 3_000) })]
            resumeObservation = resumeProjection.map(projection => ({ id: projection.id, content: projection.content })) as never
          } finally {
            client.release()
          }
        }
        const result = await execute!({ lease: input.lease, signal: input.signal })
        return result.status === "waiting_for_dependency" && durableFixture.state.wait ? { ...result, waitId: String(durableFixture.state.wait.id) } : result
      }
      const waiting = await runTurnJob({ data: { turnId: "turn_fixture", sessionId: "session_fixture", ownerId: "worker_fixture" }, attemptsMade: 0 }, { pool: durableFixture.pool as never, execute: parentExecutor, waitHandoff: waitHandoff!, now: () => now, heartbeatMs: 60_000 })
      expect(waiting).toMatchObject({ status: "waiting_for_dependency" })
      expect(waitCalls).toBe(1)
      expect(durableFixture.state.wait).toMatchObject({ status: "waiting", targetTaskIds: [child.id] })
      expect(durableFixture.state.turn.leaseVersion).toBe(1)

      const waitId = String(durableFixture.state.wait?.id)
      expect(durableFixture.state.wait).toMatchObject({ status: "waiting", suspendedAt: now })
      expect(durableFixture.state.turn).toMatchObject({ status: "waiting_for_dependency", leaseOwnerId: null })

      expect(bootstrappedChildExecutor).toBe(childExecutor)
      const childOutcome = await manager.run({ taskId: child.id, sessionId: "session_fixture", rootTaskId: "root_fixture", ownerId: "queue_fixture" }, bootstrappedChildExecutor!)
      expect(childOutcome).toMatchObject({ taskId: child.id, status: "completed" })
      expect(tasks.get(child.id)?.result).toMatchObject({ status: "completed", toolCallCount: 1, finalText: "Child found job-fixture." })

      await expect(reconcileDurableWaits(durableFixture.pool as never, { now: new Date(now.getTime() + 1_000), ownerId: "resolver_fixture" })).resolves.toEqual({ scanned: 1, resolved: 1, woken: 1 })
      expect(durableFixture.state.wait).toMatchObject({ status: "ready", matchedTaskIds: [child.id] })
      expect(durableFixture.state.turn).toMatchObject({ status: "queued", leaseOwnerId: null })
      expect(durableFixture.state.events).toHaveLength(1)
      expect(durableFixture.state.outbox.filter(item => item.topic === "agent.session.event")).toHaveLength(1)
      expect(durableFixture.state.outbox.filter(item => item.topic === "agent.turn.dispatch")).toHaveLength(1)

      await expect(reconcileDurableWaits(durableFixture.pool as never, { now: new Date(now.getTime() + 2_000), ownerId: "resolver_fixture" })).resolves.toEqual({ scanned: 0, resolved: 0, woken: 0 })
      await expect(durableWait.suspendAndRelease({ lease: firstLease, waitId, now })).resolves.toMatchObject({ handoff: "queued", idempotent: true })
      expect(durableFixture.state.events).toHaveLength(1)
      expect(durableFixture.state.outbox.filter(item => item.topic === "agent.session.event")).toHaveLength(1)
      expect(durableFixture.state.outbox.filter(item => item.topic === "agent.turn.dispatch")).toHaveLength(1)

      await expect(durableWait.wait({ userId: "user_fixture", sessionId: "session_fixture", turnId: "turn_fixture", stepId: String(durableFixture.state.wait?.stepId), taskId: "root_fixture", rootTaskId: "root_fixture", targetTaskIds: [child.id], mode: "all", timeoutMs: 1_000, idempotencyKey: "wait_fixture" })).resolves.toMatchObject({ status: "ready", matchedTaskIds: [child.id] })

      expect(durableFixture.state.turn.status).toBe("queued")
      parentResuming = true
      const resumed = await runTurnJob({ data: { turnId: "turn_fixture", sessionId: "session_fixture", ownerId: "worker_resume" }, attemptsMade: 0 }, { pool: durableFixture.pool as never, execute: parentExecutor, now: () => new Date(now.getTime() + 3_000), heartbeatMs: 60_000 })
      expect(resumed).toMatchObject({ status: "completed" })
      expect(waitCalls).toBe(1)
      expect(projectionCalls).toBe(1)
      expect(resumeProjection).toHaveLength(1)
      expect(JSON.stringify(resumeProjection[0]?.content)).toContain("Child found job-fixture.")
      expect(durableFixture.state.turn).toMatchObject({ status: "completed", leaseOwnerId: null, leaseVersion: 2 })
      expect(JSON.stringify(requests[2]?.messages)).toContain("Child found job-fixture.")
      expect(childModelRuntimeFactory).toHaveBeenCalledOnce()
      expect(childToolRuntimeFactory).toHaveBeenCalledOnce()
      expect(childRequests).toHaveLength(2)
      expect(childRequests[0]?.tools).toEqual([expect.objectContaining({ name: "fixture.read" })])
      expect(childTool).toHaveBeenCalledOnce()
      expect(childToolCalls).toHaveLength(1)
      expect(childToolCalls[0]?.context).toMatchObject({ taskId: child.id, rootTaskId: "root_fixture", actorRole: "subagent" })
      expect(childBudget.reserve).toHaveBeenCalledTimes(2)
      expect(childBudget.settle).toHaveBeenCalledTimes(2)
      expect(childBudgetReservations.every(reservation => reservation.status === "consumed")).toBe(true)
      expect(requests).toHaveLength(4)
    } finally {
      await bootstrap.close()
      vi.useRealTimers()
    }
  })
})
