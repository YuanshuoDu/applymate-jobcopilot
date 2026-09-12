import type { ModelAdapter } from "@jobcopilot/agent-model"
import type { PolicyRole } from "@jobcopilot/agent-protocol"
import { loadWorkerAiConfig, type AiConfig } from "@jobcopilot/shared/llm"

import { executionOwnerFence } from "../execution-owner.js"
import type { ContextSnapshotAdapter } from "../context/context-snapshot-adapter.js"
import { createHarnessModelRuntime } from "../harness-model.js"
import { visibleToolPolicy, getSubagentRolePolicy } from "./role-policy.js"
import { childContextSnapshot, createChildContextBuilder } from "./child-context.js"
import { SubagentLeaseError, type SubagentExecutionResult, type SubagentLease, type SubagentTaskRecord } from "./types.js"
import type { TurnExecutionStore } from "../turns/turn-execution-types.js"
import { createToolRouterExecutor } from "../turns/turn-engine-helpers.js"
import { runTurnExecutionLoop } from "../turns/turn-execution-loop.js"
import { createUsageAwareModelAdapter, type UsageAwareModelOptions } from "../turns/usage-aware-model.js"
import type { TreeBudgetReservationStore } from "./tree-budget-types.js"
import type { RuntimeToolDefinition, ToolRouterContext, ToolExecutionResult, ToolCallRequest } from "../tools/types.js"

/** Public metadata keeps the runtime's readonly tool contracts without exposing execution functions to the model. */
export type ChildPublicDefinition = Omit<RuntimeToolDefinition, "execute">

export type ChildToolRuntime = {
  readonly definitions: readonly ChildPublicDefinition[]
  readonly router: { execute(context: ToolRouterContext, request: ToolCallRequest): Promise<ToolExecutionResult> }
  readonly validateArguments?: (name: string, input: unknown, version?: string) => true | string
}

export type ChildExecutorOptions = {
  readonly store: TurnExecutionStore
  readonly treeBudget: TreeBudgetReservationStore
  readonly authorizeUsage: UsageAwareModelOptions["authorize"]
  readonly modelRuntimeFactory?: (input: { task: SubagentTaskRecord }) => Promise<ModelAdapter> | ModelAdapter
  readonly toolRuntimeFactory: (input: { task: SubagentTaskRecord; lease: SubagentLease; owner: ReturnType<typeof executionOwnerFence> }) => ChildToolRuntime
  /** Reuses the server-owned context compaction adapter when production enables it. */
  readonly contextSnapshotAdapter?: ContextSnapshotAdapter
  readonly now?: () => Date
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function configWithSnapshot(config: AiConfig, snapshot: unknown): AiConfig {
  const value = record(snapshot)
  const provider = value.provider
  const model = value.model
  return {
    ...config,
    ...(typeof provider === "string" ? { provider: provider as AiConfig["provider"] } : {}),
    ...(typeof model === "string" && model.trim() ? { model } : {}),
  }
}

async function defaultModel(task: SubagentTaskRecord): Promise<ModelAdapter> {
  const config = configWithSnapshot(await loadWorkerAiConfig(task.userId), task.modelProfileSnapshot)
  return (await createHarnessModelRuntime({ primary: config, fallbacks: [], allowEnvironmentFallbacks: false })).adapter
}

function visibleDefinitions(task: SubagentTaskRecord, definitions: readonly ChildPublicDefinition[]): ChildPublicDefinition[] {
  const policy = getSubagentRolePolicy(task.role)
  if (!policy) throw new Error("subagent_role_unknown")
  const allowedActions = new Set(Array.isArray(task.allowedActions) ? task.allowedActions.filter((action): action is string => typeof action === "string") : [])
  return definitions.filter(definition => {
    if (!allowedActions.has(definition.name)) return false
    if (definition.name === "tool_results.read") {
      return definition.risk === "read"
        && definition.idempotency === "read_only"
        && definition.capabilities.includes("read")
        && policy.allowedRisks.includes("read")
        && definition.requiredCapabilities.every(capability => policy.capabilities.includes(capability))
    }
    if (definition.domain === "coordination") return false
    return visibleToolPolicy(task.role, definition).visible
  })
}

function resultStatus(status: "completed" | "waiting_for_dependency" | "waiting_for_approval" | "waiting_for_user" | "interrupted" | "failed"): SubagentExecutionResult["status"] {
  if (status === "completed") return "completed"
  if (status === "waiting_for_dependency") return "waiting"
  // SubagentTask has no separate approval state; retain the durable wait.
  if (status === "waiting_for_approval" || status === "waiting_for_user") return "waiting_for_user"
  return "failed"
}

export function createChildExecutor(options: ChildExecutorOptions): (input: { lease: SubagentLease }) => Promise<SubagentExecutionResult> {
  if (!options.treeBudget) throw new TypeError("treeBudget is required for child execution")
  return async ({ lease }) => {
    if (!lease.turnId) return { status: "failed", failureReason: "child_turn_missing" }
    const owner = executionOwnerFence({ kind: "task", lease })
    const runtime = options.toolRuntimeFactory({ task: lease, owner, lease })
    const definitions = visibleDefinitions(lease, runtime.definitions)
    const policy = getSubagentRolePolicy(lease.role)
    if (!policy) return { status: "failed", failureReason: "subagent_role_unknown" }
    const adapter = await (options.modelRuntimeFactory?.({ task: lease }) ?? defaultModel(lease))
    const model = createUsageAwareModelAdapter(adapter, { owner, authorize: options.authorizeUsage, treeBudget: options.treeBudget })
    const result = await runTurnExecutionLoop({
      identity: owner, scope: { userId: lease.userId }, goal: lease.goal, snapshot: childContextSnapshot(lease),
      contextBuilder: createChildContextBuilder(lease), store: options.store, model, tools: definitions,
      executeTool: createToolRouterExecutor(runtime.router), actorRole: policy.actorRole, capabilities: policy.capabilities,
      validateToolArguments: runtime.validateArguments, signal: lease.signal, now: options.now, publishReasoningSummary: false,
      contextCompaction: options.contextSnapshotAdapter?.hook,
      contextCompactionLoadSnapshot: options.contextSnapshotAdapter?.loadSnapshot,
      // A retry is a new durable attempt. Keep IDs deterministic within that
      // attempt while preventing attempt 1 and attempt 2 collisions.
      idFactory: prefix => `${prefix}:attempt:${lease.attemptCount}`,
      isOwnershipLost: (error, signal) => signal.aborted || error instanceof SubagentLeaseError,
      signalError: () => new Error("subagent_lease_lost"),
    })
    return { status: resultStatus(result.status), result: { status: result.status, stepCount: result.stepCount, toolCallCount: result.toolCallCount, finalItemId: result.finalItemId ?? null }, failureReason: result.errorCode }
  }
}
