import type pg from "pg"
import type { TenantScope } from "@jobcopilot/agent-protocol"
import type { TurnEngineOptions } from "./turns/turn-engine-types.js"
import type { TurnLease } from "./turns/lease.js"
import type { InputClaimStore } from "./context/input-claim-store.js"
import { createPgContextOwnerFence, StepContextBuilder } from "./context/step-context-builder.js"
import type { HydrationScope } from "./context/steering-reconciliation-context.js"
import { injectSelectedJobMemory, type SelectedJobMemoryRecord } from "./context/selected-job-memory.js"
import { createPgDirectSelectedJobHistoryStore } from "./context/selected-job-history-direct-store.js"
import { createPgDirectRootTaskHistoryStore } from "./context/root-task-history-direct-store.js"
import { selectedJobSnapshot } from "./canonical-turn-task-graph-context.js"
import type { StepContextSnapshot } from "./context/step-context-builder.js"
import {
  appendCanonicalSelectedJobHistory, appendCanonicalSelectedJobHistoryOutcomes,
  type DirectSelectedJobHistoryReader, type SelectedJobHistoryReader,
} from "./canonical-turn-selected-job-history.js"
import { appendCanonicalRootTaskHistory, type DirectRootTaskHistoryReader } from "./canonical-turn-root-task-history.js"

type ContextBuilder = TurnEngineOptions["contextBuilder"]
type BaseBuilder = Pick<ContextBuilder, "build">

type Input = Readonly<{
  pool: Pick<pg.Pool, "connect">
  store: InputClaimStore
  baseBuilder?: BaseBuilder
  scope: TenantScope
  lease: TurnLease
  rootTaskId: string
  rootAttemptCount: number
  rootInputId?: string
  planningEnabled: boolean
  selectedJobMode: boolean
  selectedJobMemories?: readonly SelectedJobMemoryRecord[]
  selectedJobId?: string
  selectedJobDirectHistoryReader?: DirectSelectedJobHistoryReader
  /** Explicit adapter for callers that still supply compaction-captured records. Production uses the direct source reader. */
  selectedJobHistoryReader?: SelectedJobHistoryReader
  rootTaskHistoryDirectReader?: DirectRootTaskHistoryReader
}>

export function canonicalSteeringHydrationScope(input: Pick<Input, "planningEnabled" | "scope" | "lease" | "rootTaskId" | "rootAttemptCount" | "rootInputId">): HydrationScope | undefined {
  if (!input.planningEnabled) return undefined
  return {
    userId: input.scope.userId, sessionId: input.lease.sessionId, turnId: input.lease.turnId,
    rootTaskId: input.rootTaskId, parentTaskId: input.rootTaskId,
    turnLeaseOwner: input.lease.ownerId, turnLeaseVersion: input.lease.leaseVersion,
    parentLeaseOwner: input.lease.ownerId, parentAttemptCount: input.rootAttemptCount,
    rootInputId: input.rootInputId ?? null,
  }
}

export function createCanonicalTurnContextBuilder(input: Input): ContextBuilder {
  const reconciliationScope = canonicalSteeringHydrationScope(input)
  const base = input.baseBuilder ?? new StepContextBuilder(
    input.store,
    createPgContextOwnerFence(input.pool),
    undefined,
    reconciliationScope,
  )
  const directHistoryReader = input.selectedJobMode
    ? input.selectedJobDirectHistoryReader ?? (input.selectedJobHistoryReader ? undefined : createPgDirectSelectedJobHistoryStore(input.pool))
    : undefined
  const rootTaskHistoryReader = input.planningEnabled && !input.selectedJobMode
    ? input.rootTaskHistoryDirectReader ?? createPgDirectRootTaskHistoryStore(input.pool)
    : undefined
  return {
    build: async request => {
      let snapshot: StepContextSnapshot = request.snapshot
      if (input.selectedJobMode) {
        snapshot = injectSelectedJobMemory({ snapshot: selectedJobSnapshot(request.snapshot), records: input.selectedJobMemories ?? [], jobId: input.selectedJobId, turnId: input.lease.turnId, rootTaskId: input.rootTaskId })
        if (directHistoryReader) snapshot = await appendCanonicalSelectedJobHistoryOutcomes({
          snapshot, reader: directHistoryReader, lease: input.lease, rootTaskId: input.rootTaskId,
          rootAttemptCount: input.rootAttemptCount, stepId: request.stepId, jobId: input.selectedJobId,
          now: request.now ?? new Date(),
        })
        else if (input.selectedJobHistoryReader) snapshot = await appendCanonicalSelectedJobHistory({
          snapshot, reader: input.selectedJobHistoryReader, lease: input.lease, rootTaskId: input.rootTaskId,
          rootAttemptCount: input.rootAttemptCount, stepId: request.stepId, jobId: input.selectedJobId,
          records: input.selectedJobMemories ?? [], now: request.now ?? new Date(),
        })
      }
      if (rootTaskHistoryReader) snapshot = await appendCanonicalRootTaskHistory({
        snapshot, reader: rootTaskHistoryReader,
        request: { lease: input.lease, rootTaskId: input.rootTaskId, rootAttemptCount: input.rootAttemptCount, stepId: request.stepId, now: request.now ?? new Date() },
      })
      return base.build({ ...request, snapshot, taskId: input.rootTaskId })
    },
  }
}
