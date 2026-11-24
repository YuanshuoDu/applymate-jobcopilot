import type pg from "pg"

import type { CanonicalExecutionProjection } from "./canonical-execution-projection.js"
import type { CanonicalSessionProjection } from "./canonical-session-projection.js"
import { loadAndDispatchCanonicalReviewedApplicationReview } from "./canonical-reviewed-application-review-dispatch.js"
import { finalizeCanonicalObjectiveApplicationSubmit } from "./canonical-objective-application-submit-finalizer.js"
import { createCanonicalSelectedJobBatchRuntime, prepareCanonicalSelectedJobBatchRuntime } from "./canonical-selected-job-batch-runtime.js"
import { prepareCanonicalTurnSetup, type CanonicalTurnSetup } from "./canonical-turn-runtime-turn-setup.js"
import type { CanonicalTurnRuntimeOptions } from "./canonical-turn-runtime.js"
import type { TurnLease } from "./turns/lease.js"
import type { TurnExecutionResult } from "./turns/turn-queue.js"
import type { AgentTreeManager } from "./subagents/manager.js"
import type { RootTaskStore } from "./subagents/root-task-store.js"
import type { CanonicalTurnState } from "./canonical-turn-state.js"

export type CanonicalTurnReviewedBatchSetupResult =
  | Readonly<{ earlyResult: TurnExecutionResult }>
  | Readonly<{
      setup: CanonicalTurnSetup
      state: CanonicalTurnState
      selectedJobRootMode: boolean
      batchRuntime?: ReturnType<typeof createCanonicalSelectedJobBatchRuntime>
      durableWaitPort: ReturnType<typeof import("./subagents/durable-wait-store.js").createPgDurableWaitPort>
    }>

/** Preserves reviewed dispatch ordering while composing shared setup with the selected-batch runtime. */
export async function prepareCanonicalTurnReviewedBatchSetup(input: {
  readonly pool: pg.Pool
  readonly lease: TurnLease
  readonly signal: AbortSignal
  readonly now: () => Date
  readonly options: CanonicalTurnRuntimeOptions
  readonly manager: AgentTreeManager
  readonly rootTasks: RootTaskStore
  readonly executionProjection: CanonicalExecutionProjection
  readonly sessionProjection: CanonicalSessionProjection
  readonly coordinationEnabled: boolean
  readonly childExecutionEnabled: boolean
  readonly consumeWaitOutcomes: boolean
}): Promise<CanonicalTurnReviewedBatchSetupResult> {
  const review = await loadAndDispatchCanonicalReviewedApplicationReview(input)
  if (review.result) return { earlyResult: review.result }

  const state = await review.setupOptions.stateLoader()
  const submitFinalization = await finalizeCanonicalObjectiveApplicationSubmit({
    pool: input.pool, lease: input.lease, state, signal: input.signal, rootTasks: input.rootTasks,
    executionProjection: input.executionProjection, sessionProjection: input.sessionProjection, now: input.now,
    storeFactory: input.options.turnEngineStoreFactory,
  })
  if (submitFinalization) return { earlyResult: submitFinalization }

  const setup = await prepareCanonicalTurnSetup({ ...input, options: review.setupOptions,
    batchCompletionGate: createCanonicalSelectedJobBatchRuntime })
  if ("earlyResult" in setup) return setup

  const batch = prepareCanonicalSelectedJobBatchRuntime({ pool: input.pool, lease: input.lease, root: setup.root,
    state: setup.state, selectedJobBatch: setup.selectedJobBatch, commandPort: input.options.taskGraphCommandPort,
    rootTasks: input.rootTasks, now: input.now })
  return {
    setup,
    state: batch.state,
    selectedJobRootMode: setup.selectedJobMode || Boolean(setup.selectedJobBatch),
    ...(batch.runtime ? { batchRuntime: batch.runtime } : {}),
    durableWaitPort: review.durableWaitPort,
  }
}
