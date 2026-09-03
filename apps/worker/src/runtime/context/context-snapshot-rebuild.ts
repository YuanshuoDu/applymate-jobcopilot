import type { TenantScope } from "@jobcopilot/agent-protocol"

import { assertSnapshotIntegrity } from "./context-snapshot-canonical.js"
import {
  InputClaimStoreError,
  type InputClaimStore,
  type InputClaimTransaction,
  type StepCheckpoint,
} from "./input-claim-store.js"
import {
  ContextOwnershipError,
  StepContextBuilder,
  type BusinessReference,
  type ContextOwnerFence,
  type StepContext,
  type StepContextSnapshot,
} from "./step-context-builder.js"
import {
  ContextSnapshotError,
  type AgentContextSnapshot,
  type RebuildStepRequest,
} from "./context-snapshot-types.js"

function nonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ContextSnapshotError("invalid_input", `${field} must be non-empty`)
  return value
}

function sameCheckpoint(left: StepCheckpoint, right: StepCheckpoint): boolean {
  return left.inputThroughSequence === right.inputThroughSequence
    && left.consumedInputIds.length === right.consumedInputIds.length
    && left.consumedInputIds.every((id, index) => id === right.consumedInputIds[index])
}

class SnapshotReplayStore implements InputClaimStore {
  readonly scope: TenantScope

  constructor(private readonly snapshot: AgentContextSnapshot, scope: TenantScope) {
    this.scope = Object.freeze({ userId: nonEmpty(scope.userId, "scope.userId") })
  }

  private assertIdentity(sessionId: string, turnId: string, stepId: string): void {
    if (sessionId !== this.snapshot.sessionId) throw new InputClaimStoreError("owner_conflict", "Snapshot session does not match the rebuild request")
    nonEmpty(turnId, "turnId")
    nonEmpty(stepId, "stepId")
  }

  private checkpoint(): StepCheckpoint {
    return {
      inputThroughSequence: this.snapshot.throughSequence,
      consumedInputIds: [...this.snapshot.content.consumedInputIds],
    }
  }

  async withTransaction<T>(work: (transaction: InputClaimTransaction) => Promise<T>): Promise<T> {
    const transaction: InputClaimTransaction = {
      getCheckpoint: async (input) => {
        this.assertIdentity(input.sessionId, input.turnId, input.stepId)
        return this.checkpoint()
      },
      claimInputs: async (input) => {
        this.assertIdentity(input.sessionId, input.turnId, input.stepId)
        const mode = input.mode ?? (input.rebuild ? "rebuild" : "new")
        if (mode !== "rebuild" || !sameCheckpoint(input.checkpoint, this.checkpoint())) throw new InputClaimStoreError("checkpoint_conflict", "Snapshot rebuild requires its immutable checkpoint")
        return { inputs: [], newlyClaimedInputIds: [] }
      },
      persistCheckpoint: async (input) => {
        this.assertIdentity(input.sessionId, input.turnId, input.stepId)
        if (!sameCheckpoint(input.checkpoint, this.checkpoint())) throw new InputClaimStoreError("checkpoint_conflict", "Snapshot rebuild changed its immutable checkpoint")
      },
    }
    return work(transaction)
  }
}

function verifiedOwnerFence(snapshot: AgentContextSnapshot, scope: TenantScope): ContextOwnerFence {
  const references = new Map(snapshot.content.references.map((reference) => [`${reference.kind}:${reference.id}`, reference]))
  return {
    async assertReferenceOwned(reference: BusinessReference, actualScope: TenantScope): Promise<void> {
      if (actualScope.userId !== scope.userId || reference.ownerId !== scope.userId) throw new ContextOwnershipError("reference_owner_mismatch", `Reference ${reference.id} is outside the tenant scope`)
      const verified = references.get(`${reference.kind}:${reference.id}`)
      if (!verified || verified.verified !== true || verified.ownerId !== scope.userId) throw new ContextOwnershipError("reference_owner_unknown", `Reference ${reference.id} is not a verified snapshot reference`)
    },
    async assertAttachmentOwned(): Promise<{ attachmentId: string }> {
      throw new ContextOwnershipError("attachment_owner_unknown", "Snapshot rebuild cannot resolve an attachment reference")
    },
  }
}

function rebuildSnapshot(snapshot: AgentContextSnapshot): StepContextSnapshot {
  const content = snapshot.content
  return {
    system: content.context.system,
    profile: content.context.profile,
    goal: content.context.goal ?? { id: "snapshot-goal", content: content.goal },
    steerHistory: content.context.steerHistory,
    businessRefs: content.references,
    toolObservations: content.context.toolObservations,
  }
}

export async function rebuildStepFromSnapshot(snapshot: AgentContextSnapshot, request: RebuildStepRequest): Promise<StepContext> {
  assertSnapshotIntegrity(snapshot)
  nonEmpty(request.scope.userId, "scope.userId")
  nonEmpty(request.turnId, "turnId")
  nonEmpty(request.stepId, "stepId")
  if (snapshot.content.ownerId !== request.scope.userId) {
    throw new ContextSnapshotError("reference_cross_tenant", `Snapshot ${snapshot.sessionId} is outside the rebuild tenant scope`)
  }
  for (const reference of snapshot.content.references) {
    if (reference.verified !== true || reference.ownerId !== request.scope.userId) throw new ContextSnapshotError("reference_cross_tenant", `Reference ${reference.id} is outside the rebuild tenant scope`)
  }
  const store = new SnapshotReplayStore(snapshot, request.scope)
  return new StepContextBuilder(store, verifiedOwnerFence(snapshot, request.scope)).build({
    scope: request.scope,
    sessionId: snapshot.sessionId,
    turnId: request.turnId,
    stepId: request.stepId,
    snapshot: rebuildSnapshot(snapshot),
    mode: "rebuild",
    now: new Date(0),
  })
}
