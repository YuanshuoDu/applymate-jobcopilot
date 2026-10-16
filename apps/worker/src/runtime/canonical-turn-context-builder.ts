import type pg from "pg"
import type { TenantScope } from "@jobcopilot/agent-protocol"
import type { TurnEngineOptions } from "./turns/turn-engine-types.js"
import type { TurnLease } from "./turns/lease.js"
import type { InputClaimStore } from "./context/input-claim-store.js"
import { createPgContextOwnerFence, StepContextBuilder } from "./context/step-context-builder.js"
import type { HydrationScope } from "./context/steering-reconciliation-context.js"
import { injectSelectedJobMemory, type SelectedJobMemoryRecord } from "./context/selected-job-memory.js"
import { selectedJobSnapshot } from "./canonical-turn-task-graph-context.js"
import type { StepContextSnapshot } from "./context/step-context-builder.js"

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
  return {
    build: request => {
      const snapshot: StepContextSnapshot = input.selectedJobMode
        ? injectSelectedJobMemory({ snapshot: selectedJobSnapshot(request.snapshot), records: input.selectedJobMemories ?? [], jobId: input.selectedJobId, turnId: input.lease.turnId, rootTaskId: input.rootTaskId })
        : request.snapshot
      return base.build({ ...request, snapshot, taskId: input.rootTaskId })
    },
  }
}
