import type pg from "pg"

import type { CanonicalTurnRuntimeOptions } from "../runtime/canonical-turn-runtime.js"
import type { ProductionAgentFlags } from "../runtime/production-agent-flags.js"
import type { ProductionChildRuntimeOptions } from "../runtime/subagents/production-child-runtime.js"
import type { SubagentExecutor } from "./subagent-queue.js"
import type {
  ProductionAgentRuntimeStartupOptions,
  ProductionWorkerBootstrap,
} from "./production-bootstrap.js"

export type ProductionWorkerRuntimeDependencies = {
  readonly createOptionalProductionChildExecutor: (
    options: ProductionChildRuntimeOptions & { readonly enabled?: boolean },
  ) => SubagentExecutor | undefined
  readonly createCanonicalTurnRuntime: (
    pool: pg.Pool,
    options: CanonicalTurnRuntimeOptions,
  ) => ReturnType<typeof import("../runtime/canonical-turn-runtime.js").createCanonicalTurnRuntime>
  readonly createWorkerUsageAuthorizer: () => NonNullable<CanonicalTurnRuntimeOptions["authorizeUsage"]>
  readonly createCanonicalExecutionProjection: (
    pool: pg.Pool,
  ) => NonNullable<CanonicalTurnRuntimeOptions["executionProjection"]>
  readonly createCanonicalSessionProjection: (
    pool: pg.Pool,
  ) => NonNullable<CanonicalTurnRuntimeOptions["sessionProjection"]>
  readonly startProductionAgentRuntime: (
    options: ProductionAgentRuntimeStartupOptions,
  ) => Promise<ProductionWorkerBootstrap>
}

export type ProductionWorkerRuntimeInput = {
  readonly pool: pg.Pool
  readonly workerId: string
  readonly productionFlags: ProductionAgentFlags
  readonly onBootstrapReady?: ProductionAgentRuntimeStartupOptions["onBootstrapReady"]
  readonly startAgentRunWorker: ProductionAgentRuntimeStartupOptions["startAgentRunWorker"]
}

/** Assemble the production runtime and bootstrap registrations shared by Worker startup and its composition fixtures. */
export async function startProductionWorkerRuntime(
  input: ProductionWorkerRuntimeInput,
  dependencies: ProductionWorkerRuntimeDependencies,
): Promise<ProductionWorkerBootstrap> {
  const { pool, productionFlags } = input
  const waitResolver = productionFlags.consumeWaitOutcomes ? {} : undefined
  let childExecutor: SubagentExecutor | undefined

  return dependencies.startProductionAgentRuntime({
    pool,
    createRuntime: async () => {
      childExecutor = dependencies.createOptionalProductionChildExecutor({
        enabled: productionFlags.childExecutionEnabled,
        pool,
      })
      return dependencies.createCanonicalTurnRuntime(pool, {
        workerId: input.workerId,
        authorizeUsage: dependencies.createWorkerUsageAuthorizer(),
        productionFlags,
        executionProjection: dependencies.createCanonicalExecutionProjection(pool),
        sessionProjection: dependencies.createCanonicalSessionProjection(pool),
      })
    },
    bootstrapOptions: () => ({
      ...(childExecutor ? { subagents: { execute: childExecutor } } : {}),
      ...(waitResolver ? { waitResolver } : {}),
    }),
    onBootstrapReady: input.onBootstrapReady,
    startAgentRunWorker: input.startAgentRunWorker,
  })
}
