import type { TenantScope } from "@jobcopilot/agent-protocol"

export const COMPACTION_ITEM_TYPE = "context_compaction" as const

export type CompactionStatus = "started" | "completed" | "failed"
export type CompactionTriggerReason = "manual" | "input_tokens" | "item_count" | "turn_boundary"

export type CompactionTriggerPolicy = {
  readonly inputTokenThreshold: number
  readonly itemCountThreshold: number
  readonly compactAtTurnBoundary: boolean
}

export type CompactionTriggerInput = {
  readonly inputTokens: number
  readonly itemCount: number
  readonly atTurnBoundary: boolean
  readonly requested: boolean
}

export type CompactionTriggerDecision = {
  readonly shouldCompact: boolean
  readonly reason: CompactionTriggerReason | null
}

export type CompactionApproval = {
  readonly id: string
  readonly status: string
  readonly scopeHash?: string
  readonly answersHash?: string
}

export type CompactionAnswer = {
  readonly id: string
  readonly question: string
  readonly answer: string
  readonly answerHash?: string
}

export type CompactionArtifact = {
  readonly id: string
  readonly type: string
  readonly hash: string
}

export type CompactionOpenTask = {
  readonly taskId: string
  readonly status: string
  readonly blocker: string | null
}

export type CompactionFact = {
  readonly factId: string
  readonly key: string
  readonly source: string
}

export type CompactionState = {
  readonly ownerId: string
  readonly sessionId: string
  readonly throughSequence: bigint
  readonly goal: string
  readonly userConstraints: readonly string[]
  readonly approvals: readonly CompactionApproval[]
  readonly answers: readonly CompactionAnswer[]
  readonly artifacts: readonly CompactionArtifact[]
  readonly openTasks: readonly CompactionOpenTask[]
  readonly doNotRepeat: readonly string[]
  readonly facts: readonly CompactionFact[]
}

export type CompactionInputItem = {
  readonly id: string
  readonly sessionId: string
  readonly turnId: string
  readonly sequence: bigint
  readonly type: string
  readonly status: string
  readonly content: unknown
}

export type CompactionNarrativeItem = {
  readonly id: string
  readonly sequence: bigint
  readonly type: string
  readonly text: string
}

export type CompactionSource = {
  readonly state: CompactionState
  readonly items: readonly CompactionInputItem[]
}

export type CompactionBounds = {
  readonly maxNarrativeInputCharacters: number
  readonly maxSummaryCharacters: number
}

export type CompactionTokenMeasurement = {
  readonly beforeInputTokens: number
  readonly afterInputTokens: number
  readonly reductionTokens: number
  readonly reductionRatio: number
}

export type CompactionCollection = {
  readonly state: CompactionState
  readonly narrativeItems: readonly CompactionNarrativeItem[]
  readonly narrativeText: string
  readonly sourceItemIds: readonly string[]
  readonly beforeInputTokens: number
  readonly stateDigest: string
}

export type CompactionInvariantField = "goal" | "approvals" | "answers" | "artifact_hashes" | "open_tasks" | "do_not_repeat"

export type CompactionInvariantReport = {
  readonly preserved: boolean
  readonly preservedFields: readonly CompactionInvariantField[]
  readonly missingFields: readonly string[]
  readonly changedFields: readonly CompactionInvariantField[]
  readonly beforeDigest: string
  readonly afterDigest: string
}

export type CompactionSnapshotDraft = {
  readonly scope: TenantScope
  readonly turnId: string
  readonly state: CompactionState
  readonly narrativeSummary: string
  readonly tokenMeasurement: CompactionTokenMeasurement
  readonly sourceItemIds: readonly string[]
  readonly reason: CompactionTriggerReason
}

export type CompactionItemData = {
  readonly reason: CompactionTriggerReason
  readonly throughSequence: string
  readonly sourceItemCount: number
  readonly beforeInputTokens: number
  readonly afterInputTokens?: number
  readonly reductionTokens?: number
  readonly reductionRatio?: number
  readonly preservedFields: readonly CompactionInvariantField[]
  readonly summaryPreview?: string
  readonly errorCode?: string
  readonly previousSnapshotRetained?: boolean
}

export type CompactionItemRecord = {
  readonly id: string
  readonly sessionId: string
  readonly turnId: string
  readonly type: typeof COMPACTION_ITEM_TYPE
  readonly status: CompactionStatus
  readonly body: string
  readonly data: CompactionItemData
}

export type NarrativeSummarizer = (input: {
  readonly sessionId: string
  readonly throughSequence: bigint
  readonly narrativeText: string
  readonly state: CompactionState
  readonly itemCount: number
  readonly maxOutputCharacters: number
}) => Promise<string> | string

export type CompactionRequest = {
  readonly scope: TenantScope
  readonly turnId: string
  readonly source: CompactionSource
  readonly policy: CompactionTriggerPolicy
  readonly atTurnBoundary: boolean
  readonly requested: boolean
  readonly version: number
  readonly itemId?: string
  readonly bounds?: Partial<CompactionBounds>
}

export class CompactionError extends Error {
  constructor(
    readonly code: "invalid_source" | "invalid_policy" | "summarizer_failed" | "invariant_loss" | "no_token_reduction" | "publish_failed" | "lifecycle_failed",
    message: string,
  ) {
    super(message)
    this.name = "CompactionError"
  }
}

export type CompactionResult = {
  readonly status: "skipped" | "compacted" | "failed"
  readonly trigger: CompactionTriggerDecision
  readonly item: CompactionItemRecord | null
  readonly snapshot?: { readonly id: string; readonly sessionId: string; readonly throughSequence: bigint; readonly version: number }
  readonly invariantReport?: CompactionInvariantReport
  readonly tokenMeasurement?: CompactionTokenMeasurement
  readonly errorCode?: string
  readonly failureRecorded?: boolean
}
