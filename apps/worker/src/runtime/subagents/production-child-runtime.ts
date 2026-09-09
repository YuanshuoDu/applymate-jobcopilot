import type pg from "pg"
import type { PolicySnapshot } from "@jobcopilot/agent-protocol"
import { PolicyEngine } from "@jobcopilot/agent-policy"

import { createWorkerUsageAuthorizer } from "../../queue/ai-usage-bridge.js"
import type { SubagentExecutor } from "../../queue/subagent-queue.js"
import { createWorkerToolRuntime } from "../tools/index.js"
import { createPgTurnEngineStore } from "../turns/turn-engine-store.js"
import type { TurnExecutionStore } from "../turns/turn-execution-types.js"
import type { TurnEngineStore } from "../turns/turn-engine-types.js"
import { durableLifecycleSink } from "../canonical-turn-runtime.js"
import { createPgTreeBudgetReservationStore } from "./tree-budget-store.js"
import type { TreeBudgetReservationStore } from "./tree-budget-types.js"
import { createChildExecutor, type ChildExecutorOptions, type ChildToolRuntime } from "./child-executor.js"
import type { ExecutionOwner, ExecutionOwnerFence } from "../execution-owner.js"
import type { SubagentLease, SubagentTaskRecord } from "./types.js"

export type ProductionChildRuntimeOptions = {
  readonly pool: pg.Pool
  readonly authorizeUsage?: ChildExecutorOptions["authorizeUsage"]
  readonly turnStore?: TurnEngineStore
  readonly treeBudget?: TreeBudgetReservationStore
  readonly modelRuntimeFactory?: ChildExecutorOptions["modelRuntimeFactory"]
  readonly toolRuntimeFactory?: ChildExecutorOptions["toolRuntimeFactory"]
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }

function policy(value: unknown): PolicyEngine {
  const snapshot = record(value)
  return new PolicyEngine({ snapshot: typeof snapshot.version === "string" && Array.isArray(snapshot.rules) ? snapshot as unknown as PolicySnapshot : undefined })
}

function bindStore(store: TurnEngineStore): TurnExecutionStore {
  return {
    startStep: input => store.startStep({ ...withoutIdentity(input), owner: input.identity }),
    updateStep: input => store.updateStep({ ...withoutIdentity(input), owner: input.identity }),
    createItem: input => store.createItem({ ...withoutIdentity(input), owner: input.identity }),
    updateItem: input => store.updateItem({ ...withoutIdentity(input), owner: input.identity }),
    appendEvent: input => store.appendEvent({ ...withoutIdentity(input), owner: input.identity }),
  }
}

function withoutIdentity<T extends { identity: ExecutionOwnerFence }>(input: T): Omit<T, "identity"> {
  const { identity: _identity, ...rest } = input
  return rest
}

function defaultTools(pool: pg.Pool, store: TurnEngineStore, task: SubagentTaskRecord, lease: SubagentLease, owner: ExecutionOwnerFence): ChildToolRuntime {
  const executionOwner: ExecutionOwner = { kind: "task", lease }
  const runtime = createWorkerToolRuntime(pool, {
    sink: durableLifecycleSink(store, owner),
    resolveOwner: () => executionOwner,
  }, policy(task.toolPolicySnapshot))
  return { definitions: runtime.registry.list(), router: runtime.router, validateArguments: (name, input, version) => runtime.registry.validateArguments(name, input, version) }
}

export function childExecutionEnabled(value = process.env.ENABLE_AGENT_CHILD_EXECUTION): boolean {
  return value === "1"
}

/** Build the production child seam only when the explicit feature flag is on. */
export function createProductionChildExecutor(options: ProductionChildRuntimeOptions): SubagentExecutor {
  const engineStore = options.turnStore ?? createPgTurnEngineStore(options.pool)
  const treeBudget = options.treeBudget ?? createPgTreeBudgetReservationStore(options.pool)
  const authorizeUsage = options.authorizeUsage ?? createWorkerUsageAuthorizer()
  return createChildExecutor({
    store: bindStore(engineStore), treeBudget, authorizeUsage,
    modelRuntimeFactory: options.modelRuntimeFactory,
    toolRuntimeFactory: options.toolRuntimeFactory ?? (({ task, lease, owner }) => defaultTools(options.pool, engineStore, task, lease, owner)),
  })
}

export function createOptionalProductionChildExecutor(options: ProductionChildRuntimeOptions & { readonly enabled?: boolean }): SubagentExecutor | undefined {
  const enabled = options.enabled ?? childExecutionEnabled()
  return enabled ? createProductionChildExecutor(options) : undefined
}
