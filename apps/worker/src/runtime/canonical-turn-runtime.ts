import type pg from "pg"
import type { ModelAdapter } from "@jobcopilot/agent-model"
import type { PolicyRole } from "@jobcopilot/agent-protocol"
import type { PolicyEngine } from "@jobcopilot/agent-policy"
import { loadWorkerAiConfig, type AiConfig } from "@jobcopilot/shared/llm"

import { createHarnessModelRuntime, type HarnessModelRuntime } from "./harness-model.js"
import { createPgContextOwnerFence, StepContextBuilder } from "./context/step-context-builder.js"
import { createPgInputClaimStore } from "./context/input-claim-store.js"
import { createWorkerToolRuntime, type ToolLifecycleSink, type ToolRouter } from "./tools/index.js"
import type { ToolIdempotency } from "./tools/types.js"
import { createPgTurnEngineStore } from "./turns/turn-engine-store.js"
import { createToolRouterExecutor } from "./turns/turn-engine-helpers.js"
import { TurnEngine } from "./turns/turn-engine.js"
import { PgCoordinationStore } from "./mailbox/store.js"
import { createPgDurableWaitPort } from "./subagents/durable-wait-store.js"
import { capabilities, limits } from "./canonical-turn-config.js"
import type { TurnExecutor, TurnExecutionResult } from "./turns/turn-queue.js"
import type { TurnLease } from "./turns/lease.js"
import type { TurnEngineOptions, TurnEngineStore } from "./turns/turn-engine-types.js"
import { loadCanonicalTurnState, type CanonicalTurnState } from "./canonical-turn-state.js"
import { AgentTreeManager } from "./subagents/manager.js"
import { PgSubagentTaskStore } from "./subagents/pg-store.js"
import { createPgRootTaskStore, type RootTaskStore } from "./subagents/root-task-store.js"
import { executionOwnerFence, type ExecutionOwner, type ExecutionOwnerFence } from "./execution-owner.js"
import { createCanonicalPolicy } from "./policy/canonical-policy.js"
import { noopCanonicalExecutionProjection, type CanonicalExecutionProjection } from "./canonical-execution-projection.js"
import { noopCanonicalSessionProjection, type CanonicalSessionProjection } from "./canonical-session-projection.js"
import type { ProductionAgentFlags } from "./production-agent-flags.js"
import { assertCanonicalCoordinationSurface, classifyToolCallRecovery, durableLifecycleSink, isResumableRootResult } from "./turns/canonical-runtime-tool-recovery.js"

export { durableLifecycleSink } from "./turns/canonical-runtime-tool-recovery.js"

export type UsageAuthorization = {
  settle(input: { status: "success" | "error"; inputTokens: number; outputTokens: number; estimatedCostUsd: number; errorCode?: string }): Promise<void> | void
}

export type CanonicalTurnRuntimeOptions = {
  readonly workerId: string
  /** One server-owned activation contract for production route capabilities. */
  readonly productionFlags?: ProductionAgentFlags
  readonly consumeWaitOutcomes?: boolean
  /** Server-derived production gate; user policy cannot enable coordination. */
  readonly coordinationEnabled?: boolean
  readonly stateLoader?: (pool: Pick<pg.Pool, "connect">, lease: TurnLease, now?: Date) => Promise<CanonicalTurnState>
  readonly modelRuntimeFactory?: (input: { userId: string; config?: AiConfig; state: CanonicalTurnState }) => Promise<HarnessModelRuntime> | HarnessModelRuntime
  readonly authorizeUsage?: (input: { userId: string; sessionId: string; turnId: string; stepId: string; leaseOwnerId: string; leaseVersion: number; featureKey: string; provider: string; model: string }) => Promise<UsageAuthorization> | UsageAuthorization
  readonly toolRuntimeFactory?: (input: { pool: pg.Pool; policy: PolicyEngine; manager: AgentTreeManager; state: CanonicalTurnState }) => { registry: { list(capabilities?: readonly string[]): readonly unknown[]; resolve(name: string, version: string): { readonly idempotency: ToolIdempotency }; validateArguments(name: string, input: unknown, version?: string): true | string }; router: ToolRouter }
  readonly manager?: AgentTreeManager
  readonly rootTaskStore?: RootTaskStore
  readonly turnEngineStoreFactory?: (pool: pg.Pool) => TurnEngineStore
  readonly contextBuilderFactory?: (input: { pool: pg.Pool; scope: { userId: string } }) => TurnEngineOptions["contextBuilder"]
  readonly lifecycleSinkFactory?: (input: { lease: TurnLease; store: TurnEngineStore; owner: ExecutionOwnerFence }) => ToolLifecycleSink
  /** Optional server-owned automation control projection; ordinary sessions are ignored by its SQL scope. */
  readonly executionProjection?: CanonicalExecutionProjection
  /** Optional server-owned automation session projection; ordinary sessions are ignored by its SQL scope. */
  readonly sessionProjection?: CanonicalSessionProjection
  readonly now?: () => Date
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function modelWithUsage(runtime: HarnessModelRuntime, lease: TurnLease, authorize: NonNullable<CanonicalTurnRuntimeOptions["authorizeUsage"]>): ModelAdapter {
  const adapter = runtime.adapter
  return {
    ...adapter,
    async *stream(request) {
      const stepId = typeof request.metadata.stepId === "string" ? request.metadata.stepId : "unknown-step"
      const reservation = await authorize({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, stepId, leaseOwnerId: lease.ownerId, leaseVersion: lease.leaseVersion, featureKey: "autoApply", provider: adapter.profile.provider, model: adapter.profile.model })
      let settled = false
      const settle = async (input: Parameters<UsageAuthorization["settle"]>[0]): Promise<void> => {
        if (settled) return
        settled = true
        await reservation.settle(input)
      }
      let inputTokens = 0
      let outputTokens = 0
      let estimatedCostUsd = 0
      try {
        for await (const event of adapter.stream(request)) {
          if (event.type === "usage") {
            inputTokens = event.inputTokens
            outputTokens = event.outputTokens
            estimatedCostUsd = event.estimatedCostUsd ?? 0
          }
          yield event
        }
        await settle({ status: "success", inputTokens, outputTokens, estimatedCostUsd })
      } catch (error: unknown) {
        await Promise.resolve(settle({ status: "error", inputTokens, outputTokens, estimatedCostUsd, errorCode: modelErrorCode(error) })).catch(() => undefined)
        throw error
      }
    },
    ...(adapter.complete ? {
      async complete(request: Parameters<NonNullable<ModelAdapter["complete"]>>[0]) {
        const stepId = typeof request.metadata.stepId === "string" ? request.metadata.stepId : "unknown-step"
        const reservation = await authorize({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, stepId, leaseOwnerId: lease.ownerId, leaseVersion: lease.leaseVersion, featureKey: "autoApply", provider: adapter.profile.provider, model: adapter.profile.model })
        let settled = false
        const settle = async (input: Parameters<UsageAuthorization["settle"]>[0]): Promise<void> => {
          if (settled) return
          settled = true
          await reservation.settle(input)
        }
        try {
          const result = await adapter.complete!(request)
          await settle({ status: "success", inputTokens: result.usage?.inputTokens ?? 0, outputTokens: result.usage?.outputTokens ?? 0, estimatedCostUsd: result.usage?.estimatedCostUsd ?? 0 })
          return result
        } catch (error: unknown) {
          await Promise.resolve(settle({ status: "error", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, errorCode: modelErrorCode(error) })).catch(() => undefined)
          throw error
        }
      },
    } : {}),
  }
}

function modelErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && error.code.trim()) return error.code
  return "model_error"
}

function defaultAuthorization(): never {
  const error = new Error("usage_authorization_unavailable")
  Object.assign(error, { code: "usage_authorization_unavailable" })
  throw error
}

export async function createCanonicalTurnRuntime(pool: pg.Pool, options: CanonicalTurnRuntimeOptions): Promise<{
  execute: TurnExecutor
  manager: AgentTreeManager
  childExecutionEnabled: boolean
  coordinationEnabled: boolean
  close(): Promise<void>
}> {
  if (!options.workerId.trim()) throw new TypeError("workerId must be non-empty")
  const now = options.now ?? (() => new Date())
  const manager = options.manager ?? new AgentTreeManager(new PgSubagentTaskStore(pool), { now })
  const rootTasks = options.rootTaskStore ?? createPgRootTaskStore(pool)
  const executionProjection = options.executionProjection ?? noopCanonicalExecutionProjection
  const sessionProjection = options.sessionProjection ?? noopCanonicalSessionProjection
  const reconcileTerminal = options.executionProjection || options.sessionProjection ? rootTasks.reconcileTerminal : undefined
  const productionFlags = options.productionFlags
  const consumeWaitOutcomes = productionFlags?.consumeWaitOutcomes ?? options.consumeWaitOutcomes === true
  const coordinationEnabled = productionFlags?.coordinationEnabled ?? options.coordinationEnabled === true
  const childExecutionEnabled = productionFlags?.childExecutionEnabled ?? coordinationEnabled
  if (coordinationEnabled && !childExecutionEnabled) throw new Error("coordination_requires_child_execution")
  let closed = false
  const execute: TurnExecutor = async ({ lease, signal }): Promise<TurnExecutionResult> => {
    if (closed) throw new Error("canonical_runtime_closed")
    const terminal = await reconcileTerminal?.({ lease, now: now() })
    // A root task is marked waiting before a dependency/user wake releases
    // the Turn. Once the wake queues and reclaims that Turn, the root still
    // carries the old waiting result until ensure() rebinds it. Treat those
    // states as resumable; only durable terminal results may short-circuit
    // execution or a wake would be mistaken for a second terminal outcome.
    if (terminal && !isResumableRootResult(terminal.result)) {
      await executionProjection.finish({
        userId: lease.userId,
        sessionId: lease.sessionId,
        turnId: lease.turnId,
        result: { status: terminal.result.status, errorCode: terminal.result.summary },
      })
      await sessionProjection.finish({
        userId: lease.userId,
        sessionId: lease.sessionId,
        turnId: lease.turnId,
        result: { status: terminal.result.status, errorCode: terminal.result.summary },
      })
      return terminal.result
    }
    const state = options.stateLoader
      ? await options.stateLoader(pool, lease, now())
      : await loadCanonicalTurnState(pool, lease, now(), { consumeWaitOutcomes })
    const selectedPolicy = createCanonicalPolicy(state.toolPolicySnapshot, coordinationEnabled)
    const configuredCapabilities = capabilities(state.toolPolicySnapshot).filter(capability => capability !== "canManageChildren")
    const toolCapabilities = [...new Set([
      ...configuredCapabilities,
      ...(coordinationEnabled ? ["canManageChildren"] : []),
    ])]
    const turnStore = options.turnEngineStoreFactory?.(pool) ?? createPgTurnEngineStore(pool)
    let lifecycleSink: ToolLifecycleSink | null = null
    let lifecycleOwner: ExecutionOwner | null = null
    const sinkProxy: ToolLifecycleSink = { append: async (event) => {
      if (!lifecycleSink) throw new Error("root_task_not_bound")
      await lifecycleSink.append(event)
    } }
    const resolveOwner = () => {
      if (!lifecycleOwner) throw new Error("tool_result_owner_unavailable")
      return lifecycleOwner
    }
    const coordination = coordinationEnabled ? {
      manager,
      store: new PgCoordinationStore(pool),
      wait: createPgDurableWaitPort(pool),
    } : undefined
    const toolRuntime = options.toolRuntimeFactory?.({ pool, policy: selectedPolicy, manager, state }) ?? createWorkerToolRuntime(pool, { sink: sinkProxy, resolveOwner }, selectedPolicy, coordination)
    if (coordinationEnabled) assertCanonicalCoordinationSurface(toolRuntime.registry, toolCapabilities)
    const allowedActions = toolRuntime.registry.list(toolCapabilities).flatMap((definition) => {
      const name = definition && typeof definition === "object" && "name" in definition ? (definition as { name?: unknown }).name : undefined
      return typeof name === "string" ? [name] : []
    })
    const root = await rootTasks.ensure({ lease, goal: state.goal, modelProfileSnapshot: state.modelProfileSnapshot, toolPolicySnapshot: state.toolPolicySnapshot, budgetSnapshot: state.budgetSnapshot, allowedActions, now: now() })
    const owner = executionOwnerFence({ kind: "turn", taskId: root.id, lease })
    lifecycleOwner = { kind: "turn", taskId: root.id, lease }
    lifecycleSink = options.lifecycleSinkFactory?.({ lease, store: turnStore, owner }) ?? durableLifecycleSink(turnStore, owner)
    const config = options.modelRuntimeFactory ? undefined : await loadWorkerAiConfig(lease.userId)
    const modelRuntime = await (options.modelRuntimeFactory?.({ userId: lease.userId, config, state }) ?? createHarnessModelRuntime({ primary: config, fallbacks: [], allowEnvironmentFallbacks: false }))
    const authorize = options.authorizeUsage ?? defaultAuthorization
    const model = modelWithUsage(modelRuntime, lease, authorize)
    const inputStore = createPgInputClaimStore(pool, state.scope)
    const baseContextBuilder = options.contextBuilderFactory?.({ pool, scope: state.scope }) ?? new StepContextBuilder(inputStore, createPgContextOwnerFence(pool))
    const contextBuilder: TurnEngineOptions["contextBuilder"] = {
      build: request => baseContextBuilder.build({ ...request, taskId: root.id }),
    }
    const actorRole = (record(state.toolPolicySnapshot).role as PolicyRole | undefined) ?? "orchestrator"
    const engine = new TurnEngine({
      lease, scope: state.scope, goal: state.goal, snapshot: state.snapshot, contextBuilder,
      store: turnStore, model, tools: toolRuntime.registry.list(toolCapabilities),
      executeTool: createToolRouterExecutor(toolRuntime.router), rootInputId: state.rootInputId, rootTaskId: root.id, taskId: root.id,
      actorRole, capabilities: toolCapabilities,
      validateToolArguments: (name, input) => toolRuntime.registry.validateArguments(name, input, "1"), signal,
      budget: limits(state.budgetSnapshot), resume: state.resume, now, publishReasoningSummary: false,
      steeringMarkerState: { active: state.steeringMarkers?.active ?? [] },
      ...(state.pendingToolCalls?.length ? { toolCallRecovery: classifyToolCallRecovery(state.pendingToolCalls, (name, version) => toolRuntime.registry.resolve(name, version)) } : {}),
      ...(rootTasks.checkCompletion ? { completionGate: async () => rootTasks.checkCompletion!({ lease, rootTaskId: root.id, now: now() }) } : {}),
    })
    await executionProjection.start({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId })
    await sessionProjection.start({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId })
    const result = await engine.run()
    await rootTasks.finish({ lease, rootTaskId: root.id, result, now: now() })
    // The durable root is finalized first; a projection failure remains surfaced so queue retry can reconcile it.
    await executionProjection.finish({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, result })
    await sessionProjection.finish({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, result })
    return { status: result.status, summary: result.errorCode, ...(result.waitId ? { waitId: result.waitId } : {}) }
  }
  return {
    execute,
    manager,
    childExecutionEnabled,
    coordinationEnabled,
    async close() { closed = true },
  }
}
