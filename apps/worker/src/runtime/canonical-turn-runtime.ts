import { createHash } from "node:crypto"
import type pg from "pg"
import type { ModelAdapter } from "@jobcopilot/agent-model"
import type { PolicyRole, PolicySnapshot } from "@jobcopilot/agent-protocol"
import { PolicyEngine } from "@jobcopilot/agent-policy"
import { loadWorkerAiConfig, type AiConfig } from "@jobcopilot/shared/llm"

import { createHarnessModelRuntime, type HarnessModelRuntime } from "./harness-model.js"
import { createPgContextOwnerFence, StepContextBuilder } from "./context/step-context-builder.js"
import { createPgInputClaimStore } from "./context/input-claim-store.js"
import { createWorkerToolRuntime, type ToolLifecycleEvent, type ToolLifecycleSink, type ToolRouter } from "./tools/index.js"
import { createPgTurnEngineStore } from "./turns/turn-engine-store.js"
import { createToolRouterExecutor } from "./turns/turn-engine-helpers.js"
import { TurnEngine } from "./turns/turn-engine.js"
import type { TurnBudgetLimits } from "./budget.js"
import type { TurnExecutor, TurnExecutionResult } from "./turns/turn-queue.js"
import type { TurnLease } from "./turns/lease.js"
import { toRepositoryJson, type TurnEngineOptions, type TurnEngineStore } from "./turns/turn-engine-types.js"
import { loadCanonicalTurnState, type CanonicalTurnState } from "./canonical-turn-state.js"
import { AgentTreeManager } from "./subagents/manager.js"
import { PgSubagentTaskStore } from "./subagents/pg-store.js"
import { createPgRootTaskStore, type RootTaskStore } from "./subagents/root-task-store.js"

export type UsageAuthorization = {
  settle(input: { status: "success" | "error"; inputTokens: number; outputTokens: number; estimatedCostUsd: number; errorCode?: string }): Promise<void> | void
}

export type CanonicalTurnRuntimeOptions = {
  readonly workerId: string
  readonly stateLoader?: (pool: Pick<pg.Pool, "connect">, lease: TurnLease, now?: Date) => Promise<CanonicalTurnState>
  readonly modelRuntimeFactory?: (input: { userId: string; config?: AiConfig; state: CanonicalTurnState }) => Promise<HarnessModelRuntime> | HarnessModelRuntime
  readonly authorizeUsage?: (input: { userId: string; sessionId: string; turnId: string; stepId: string; leaseOwnerId: string; leaseVersion: number; featureKey: string; provider: string; model: string }) => Promise<UsageAuthorization> | UsageAuthorization
  readonly toolRuntimeFactory?: (input: { pool: pg.Pool; policy: PolicyEngine; manager: AgentTreeManager; state: CanonicalTurnState }) => { registry: { list(capabilities?: readonly string[]): readonly unknown[]; validateArguments(name: string, input: unknown, version?: string): true | string }; router: ToolRouter }
  readonly manager?: AgentTreeManager
  readonly rootTaskStore?: RootTaskStore
  readonly turnEngineStoreFactory?: (pool: pg.Pool) => TurnEngineStore
  readonly contextBuilderFactory?: (input: { pool: pg.Pool; scope: { userId: string } }) => TurnEngineOptions["contextBuilder"]
  readonly lifecycleSinkFactory?: (input: { lease: TurnLease; store: TurnEngineStore }) => ToolLifecycleSink
  readonly now?: () => Date
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function policy(value: unknown): PolicyEngine {
  const snapshot = record(value)
  return new PolicyEngine({ snapshot: typeof snapshot.version === "string" && Array.isArray(snapshot.rules) ? snapshot as unknown as PolicySnapshot : undefined })
}

function capabilities(value: unknown): readonly string[] {
  const list = record(value).capabilities
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : ["read"]
}

function limits(value: unknown): TurnBudgetLimits | undefined {
  const raw = record(value).limits ?? value
  const source = record(raw)
  const names = { maxSteps: "maxSteps", maxToolCalls: "maxToolCalls", maxInputTokens: "maxInputTokens", maxOutputTokens: "maxOutputTokens", maxCostUsd: "maxCostUsd" } as const
  const result: Partial<TurnBudgetLimits> = {}
  for (const [name, key] of Object.entries(names) as Array<[keyof TurnBudgetLimits, string]>) if (typeof source[key] === "number" && Number.isFinite(source[key]) && source[key] >= 0) (result as Record<string, number>)[name] = source[key]
  return Object.keys(result).length > 0 ? result : undefined
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

/** Persists lifecycle receipts even when TurnEngine's own item stream is incomplete. */
function durableLifecycleSink(store: TurnEngineStore, lease: TurnLease): ToolLifecycleSink {
  return {
    async append(event: ToolLifecycleEvent): Promise<void> {
      const digest = createHash("sha256").update(JSON.stringify(event.payload)).digest("hex").slice(0, 24)
      await store.appendEvent({
        lease,
        id: `tool-lifecycle:${event.item.toolCallId}:${event.phase}:${digest}`,
        itemId: null,
        type: event.eventType,
        correlationId: event.item.toolCallId,
        causationId: null,
        idempotencyKey: `turn:${lease.turnId}:tool-lifecycle:${event.item.toolCallId}:${event.phase}:${digest}`,
        payload: toRepositoryJson(event.payload),
      })
    },
  }
}

function defaultAuthorization(): never {
  const error = new Error("usage_authorization_unavailable")
  Object.assign(error, { code: "usage_authorization_unavailable" })
  throw error
}

export async function createCanonicalTurnRuntime(pool: pg.Pool, options: CanonicalTurnRuntimeOptions): Promise<{ execute: TurnExecutor; manager: AgentTreeManager; close(): Promise<void> }> {
  if (!options.workerId.trim()) throw new TypeError("workerId must be non-empty")
  const now = options.now ?? (() => new Date())
  const manager = options.manager ?? new AgentTreeManager(new PgSubagentTaskStore(pool), { now })
  const rootTasks = options.rootTaskStore ?? createPgRootTaskStore(pool)
  const loadState = options.stateLoader ?? loadCanonicalTurnState
  let closed = false
  const execute: TurnExecutor = async ({ lease, signal }): Promise<TurnExecutionResult> => {
    if (closed) throw new Error("canonical_runtime_closed")
    const state = await loadState(pool, lease, now())
    const selectedPolicy = policy(state.toolPolicySnapshot)
    const toolCapabilities = capabilities(state.toolPolicySnapshot)
    const turnStore = options.turnEngineStoreFactory?.(pool) ?? createPgTurnEngineStore(pool)
    const sink = options.lifecycleSinkFactory?.({ lease, store: turnStore }) ?? durableLifecycleSink(turnStore, lease)
    const toolRuntime = options.toolRuntimeFactory?.({ pool, policy: selectedPolicy, manager, state }) ?? createWorkerToolRuntime(pool, { sink }, selectedPolicy, { manager })
    const allowedActions = toolRuntime.registry.list(toolCapabilities).flatMap((definition) => {
      const name = definition && typeof definition === "object" && "name" in definition ? (definition as { name?: unknown }).name : undefined
      return typeof name === "string" ? [name] : []
    })
    const root = await rootTasks.ensure({ lease, goal: state.goal, modelProfileSnapshot: state.modelProfileSnapshot, toolPolicySnapshot: state.toolPolicySnapshot, budgetSnapshot: state.budgetSnapshot, allowedActions, now: now() })
    const config = options.modelRuntimeFactory ? undefined : await loadWorkerAiConfig(lease.userId)
    const modelRuntime = await (options.modelRuntimeFactory?.({ userId: lease.userId, config, state }) ?? createHarnessModelRuntime({ primary: config, fallbacks: [], allowEnvironmentFallbacks: false }))
    const authorize = options.authorizeUsage ?? defaultAuthorization
    const model = modelWithUsage(modelRuntime, lease, authorize)
    const inputStore = createPgInputClaimStore(pool, state.scope)
    const contextBuilder = options.contextBuilderFactory?.({ pool, scope: state.scope }) ?? new StepContextBuilder(inputStore, createPgContextOwnerFence(pool))
    const engine = new TurnEngine({
      lease, scope: state.scope, goal: state.goal, snapshot: state.snapshot, contextBuilder,
      store: turnStore, model, tools: toolRuntime.registry.list(capabilities(state.toolPolicySnapshot)),
      executeTool: createToolRouterExecutor(toolRuntime.router), rootInputId: state.rootInputId, rootTaskId: root.id, taskId: root.id,
      actorRole: (record(state.toolPolicySnapshot).role as PolicyRole | undefined) ?? "orchestrator", capabilities: toolCapabilities,
      validateToolArguments: (name, input) => toolRuntime.registry.validateArguments(name, input, "1"), signal,
      budget: limits(state.budgetSnapshot), resume: state.resume, now, publishReasoningSummary: false,
    })
    const result = await engine.run()
    await rootTasks.finish({ lease, rootTaskId: root.id, result, now: now() })
    return { status: result.status, summary: result.errorCode }
  }
  return {
    execute,
    manager,
    async close() { closed = true },
  }
}
