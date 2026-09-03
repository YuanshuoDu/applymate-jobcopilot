import type { TenantScope } from "@jobcopilot/agent-protocol"

import type {
  BusinessReference,
  ContextHistoryEntry,
  ContextSeedBlock,
  StepContext,
} from "./step-context-builder.js"

export const CONTEXT_SNAPSHOT_SCHEMA_VERSION = "agent-harness.context.v1" as const

export type ContextSnapshotReference = BusinessReference & {
  readonly source: string
}

export type VerifiedContextReference = ContextSnapshotReference & {
  readonly verified: true
}

export type ContextSnapshotReferenceVerification = ContextSnapshotReference & {
  readonly verified?: boolean
}

export type ContextSnapshotDecisionInput = {
  readonly id: string
  readonly decision: string
  readonly evidenceEventIds: readonly string[]
  readonly sequence?: bigint | number | string
}

export type ContextSnapshotCompletedWork = {
  readonly taskId: string
  readonly resultRef: string
  readonly summary: string
  readonly sequence?: bigint | number | string
}

export type ContextSnapshotOpenWork = {
  readonly taskId: string
  readonly status: string
  readonly blocker: string | null
  readonly sequence?: bigint | number | string
}

export type ContextSnapshotArtifact = {
  readonly id: string
  readonly type: string
  readonly hash: string
}

export type ContextSnapshotFact = {
  readonly factId: string
  readonly key: string
  readonly source: string
}

export type ContextSnapshotFailedAttempt = {
  readonly taskId: string
  readonly reason: string
  readonly doNotRepeat: readonly string[]
  readonly sequence?: bigint | number | string
}

export type ContextSnapshotTokenUsage = {
  readonly provider: string
  readonly model: string
  readonly profileId?: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly estimatedCostUsd: number
}

export type ContextSnapshotTokenProfile = {
  readonly profileKey: string
  readonly provider: string
  readonly model: string
  readonly profileId?: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly estimatedCostUsd: number
}

export type ContextSnapshotTokenAccounting = {
  readonly profiles: readonly ContextSnapshotTokenProfile[]
  readonly totalInputTokens: number
  readonly totalOutputTokens: number
  readonly totalCostUsd: number
}

export type ContextSnapshotContextSeeds = {
  readonly system: readonly ContextSeedBlock[]
  readonly profile: readonly ContextSeedBlock[]
  readonly goal?: ContextSeedBlock
  readonly steerHistory: readonly ContextHistoryEntry[]
  readonly toolObservations: readonly ContextSeedBlock[]
}

export type ContextSnapshotSourceData = {
  readonly goal: string
  readonly userConstraints: readonly string[]
  readonly confirmedDecisions: readonly ContextSnapshotDecisionInput[]
  readonly completedWork: readonly ContextSnapshotCompletedWork[]
  readonly openWork: readonly ContextSnapshotOpenWork[]
  readonly pendingApprovals: readonly string[]
  readonly artifacts: readonly ContextSnapshotArtifact[]
  readonly facts: readonly ContextSnapshotFact[]
  readonly failedAttempts: readonly ContextSnapshotFailedAttempt[]
  readonly references: readonly ContextSnapshotReference[]
  readonly tokenUsage: readonly ContextSnapshotTokenUsage[]
  readonly consumedInputIds?: readonly string[]
  readonly context?: Partial<ContextSnapshotContextSeeds>
}

export type ContextSnapshotContent = {
  readonly schemaVersion: typeof CONTEXT_SNAPSHOT_SCHEMA_VERSION
  readonly ownerId: string
  readonly sessionId: string
  readonly throughSequence: string
  readonly goal: string
  readonly userConstraints: readonly string[]
  readonly confirmedDecisions: readonly ContextSnapshotDecisionInput[]
  readonly completedWork: readonly ContextSnapshotCompletedWork[]
  readonly openWork: readonly ContextSnapshotOpenWork[]
  readonly pendingApprovals: readonly string[]
  readonly artifacts: readonly ContextSnapshotArtifact[]
  readonly facts: readonly ContextSnapshotFact[]
  readonly failedAttempts: readonly ContextSnapshotFailedAttempt[]
  readonly references: readonly VerifiedContextReference[]
  readonly consumedInputIds: readonly string[]
  readonly context: ContextSnapshotContextSeeds
  readonly tokenAccounting: ContextSnapshotTokenAccounting
}

export type AgentContextSnapshot = {
  readonly id?: string
  readonly sessionId: string
  readonly throughSequence: bigint
  readonly version: number
  readonly schemaVersion: typeof CONTEXT_SNAPSHOT_SCHEMA_VERSION
  readonly content: ContextSnapshotContent
  readonly summary: string
  readonly memorySummary: string
  readonly checksum: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly estimatedCostUsd: number
  readonly tokenAccounting: ContextSnapshotTokenAccounting
  readonly canonicalJson: string
  readonly createdAt?: Date
}

export type ContextSnapshotBuildRequest = {
  readonly scope: TenantScope
  readonly sessionId: string
  readonly throughSequence: bigint
  readonly version: number
}

export type ContextSnapshotSourcePort = {
  load(input: {
    readonly scope: TenantScope
    readonly sessionId: string
    readonly throughSequence: bigint
  }): Promise<ContextSnapshotSourceData | null>
}

export type VerifiedContextReferencePort = {
  verify(
    reference: ContextSnapshotReference,
    scope: TenantScope,
  ): Promise<ContextSnapshotReferenceVerification | null>
}

export type ContextSnapshotStorePort = {
  save(snapshot: AgentContextSnapshot, scope: TenantScope): Promise<AgentContextSnapshot>
  load(input: {
    readonly scope: TenantScope
    readonly sessionId: string
    readonly throughSequence: bigint
  }): Promise<AgentContextSnapshot | null>
}

export type RebuildStepRequest = {
  readonly scope: TenantScope
  readonly turnId: string
  readonly stepId: string
}

export class ContextSnapshotError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "source_missing"
      | "reference_missing"
      | "reference_cross_tenant"
      | "reference_unverified"
      | "duplicate_reference"
      | "token_invalid"
      | "checksum_mismatch"
      | "snapshot_conflict"
      | "session_not_found"
      | "store_conflict",
    message: string,
  ) {
    super(message)
    this.name = "ContextSnapshotError"
  }
}

export type RebuiltStepContext = StepContext
