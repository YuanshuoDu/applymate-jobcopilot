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
import type { ContextSnapshotAdapter } from "../context/context-snapshot-adapter.js"
import { createPgTreeBudgetReservationStore } from "./tree-budget-store.js"
import type { TreeBudgetReservationStore } from "./tree-budget-types.js"
import { createChildExecutor, type ChildExecutorOptions, type ChildToolRuntime } from "./child-executor.js"
import { loadChildAttemptResume } from "./child-resume.js"
import { PgCoordinationStore } from "../mailbox/store.js"
import type { ExecutionOwner, ExecutionOwnerFence } from "../execution-owner.js"
import type { SubagentLease, SubagentTaskRecord } from "./types.js"

export type ProductionChildRuntimeOptions = {
  readonly pool: pg.Pool
  readonly authorizeUsage?: ChildExecutorOptions["authorizeUsage"]
  readonly turnStore?: TurnEngineStore
  readonly treeBudget?: TreeBudgetReservationStore
  readonly modelRuntimeFactory?: ChildExecutorOptions["modelRuntimeFactory"]
  readonly toolRuntimeFactory?: ChildExecutorOptions["toolRuntimeFactory"]
  readonly contextSnapshotAdapter?: ContextSnapshotAdapter
  readonly mailboxReader?: ChildExecutorOptions["mailboxReader"]
  readonly resumeLoader?: ChildExecutorOptions["resumeLoader"]
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
    appendEvents: store.appendEvents ? (inputs) => store.appendEvents!(inputs.map(input => ({ ...withoutIdentity(input), owner: input.identity }))) : undefined,
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

function defaultMailboxReader(pool: pg.Pool): ChildExecutorOptions["mailboxReader"] | undefined {
  // Keep lightweight construction fixtures usable; a real pg.Pool exposes
  // both methods and therefore gets the server-owned reader.
  const candidate = pool as unknown as { readonly connect?: unknown; readonly query?: unknown }
  if (typeof candidate.connect !== "function" || typeof candidate.query !== "function") return undefined
  return new PgCoordinationStore(pool)
}

function defaultResumeLoader(pool: pg.Pool): ChildExecutorOptions["resumeLoader"] | undefined {
  const candidate = pool as unknown as { readonly connect?: unknown }
  if (typeof candidate.connect !== "function") return undefined
  return lease => loadChildAttemptResume(pool, lease)
}

/** Build the production child seam only when the explicit feature flag is on. */
export function createProductionChildExecutor(options: ProductionChildRuntimeOptions): SubagentExecutor {
  const engineStore = options.turnStore ?? createPgTurnEngineStore(options.pool)
  const treeBudget = options.treeBudget ?? createPgTreeBudgetReservationStore(options.pool)
  const authorizeUsage = options.authorizeUsage ?? createWorkerUsageAuthorizer()
  const mailboxReader = options.mailboxReader ?? defaultMailboxReader(options.pool)
  const resumeLoader = options.resumeLoader ?? defaultResumeLoader(options.pool)
  return createChildExecutor({
    store: bindStore(engineStore), treeBudget, authorizeUsage,
    modelRuntimeFactory: options.modelRuntimeFactory,
    toolRuntimeFactory: options.toolRuntimeFactory ?? (({ task, lease, owner }) => defaultTools(options.pool, engineStore, task, lease, owner)),
    contextSnapshotAdapter: options.contextSnapshotAdapter,
    mailboxReader, resumeLoader,
  })
}

export function createOptionalProductionChildExecutor(options: ProductionChildRuntimeOptions & { readonly enabled?: boolean }): SubagentExecutor | undefined {
  const enabled = options.enabled ?? childExecutionEnabled()
  return enabled ? createProductionChildExecutor(options) : undefined
}
