import { Buffer } from "node:buffer"
import type { TenantScope } from "@jobcopilot/agent-protocol"

import type { CompactionItemRecord, CompactionSnapshotDraft } from "./context-compaction-types.js"
import type { ExecutionOwnerFence } from "../execution-owner.js"
import type { StepContextSnapshot } from "./step-context-builder.js"

export type CompactionSnapshotRef = {
  readonly id: string
  readonly sessionId: string
  readonly throughSequence: bigint
  readonly version: number
}

/**
 * AH2-034 integration seam. The current base has no snapshot modules. After
 * #416 lands, its AgentContextSnapshotBuilder/ContextSnapshotStore adapter
 * should map draft.state into ContextSnapshotSourceData, keep answers durable,
 * and execute publishAtomically in the same PostgreSQL transaction as the
 * completed context_compaction Item/Event. This port deliberately exposes no
 * delete or update operation for historical snapshots.
 */
export type ContextSnapshotCompactionPort = {
  loadLatest(input: { readonly scope: TenantScope; readonly sessionId: string }): Promise<CompactionSnapshotRef | null>
  recordStarted(item: CompactionItemRecord, scope: TenantScope): Promise<void>
  publishAtomically(input: {
    readonly scope: TenantScope
    readonly previousSnapshot: CompactionSnapshotRef | null
    readonly draft: CompactionSnapshotDraft
    readonly startedItem: CompactionItemRecord
    readonly completedItem: CompactionItemRecord
  }): Promise<CompactionSnapshotRef>
  recordFailed(item: CompactionItemRecord, scope: TenantScope): Promise<void>
}

/** Optional server-owned seam used immediately before a model request. */
export type ContextCompactionHookInput = {
  readonly identity: ExecutionOwnerFence
  readonly scope: TenantScope
  readonly sessionId: string
  readonly turnId: string
  readonly stepId: string
  readonly signal: AbortSignal
  readonly now: Date
  readonly snapshot: StepContextSnapshot
  readonly estimatedInputTokens: number
  readonly estimatedBytes: number
  readonly idempotencyKey: string
}

export type ContextCompactionHookResult =
  | { readonly status: "unchanged"; readonly snapshot: StepContextSnapshot }
  | { readonly status: "compacted"; readonly snapshot: StepContextSnapshot; readonly snapshotRef: string }

export type ContextCompactionHook = (input: ContextCompactionHookInput) => Promise<ContextCompactionHookResult> | ContextCompactionHookResult
export type ContextCompactionSnapshotLoader = (input: {
  readonly snapshotRef: string
  readonly scope: TenantScope
  readonly sessionId: string
  readonly turnId: string
}) => Promise<{ readonly snapshot: StepContextSnapshot; readonly scope: TenantScope; readonly sessionId: string; readonly turnId: string } | null> | { readonly snapshot: StepContextSnapshot; readonly scope: TenantScope; readonly sessionId: string; readonly turnId: string } | null

export type ContextCompactionObservation = {
  readonly id: string
  readonly content: {
    readonly kind: "context_compacted"
    readonly status: "unchanged" | "compacted" | "failed"
    readonly stepId: string
    readonly idempotencyKey: string
    readonly beforeInputTokens: number
    readonly afterInputTokens: number
    readonly beforeBytes: number
    readonly afterBytes: number
    readonly snapshotRef?: string
    readonly errorCode?: "context_compaction_failed"
  }
}

const MAX_OBSERVATION_BYTES = 8 * 1024

export function parseContextCompactionObservation(value: unknown): ContextCompactionObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (row.kind !== "context_compacted" || typeof row.observationId !== "string" || row.observationId.length === 0 || row.observationId.length > 256) return null
  const allowed = new Set(["kind", "observationId", "status", "stepId", "idempotencyKey", "beforeInputTokens", "afterInputTokens", "beforeBytes", "afterBytes", "snapshotRef", "errorCode"])
  if (Object.keys(row).some(key => !allowed.has(key))) return null
  if (!(["unchanged", "compacted", "failed"] as const).includes(row.status as never)) return null
  const text = JSON.stringify(value)
  if (text === undefined || Buffer.byteLength(text, "utf8") > MAX_OBSERVATION_BYTES) return null
  const numberFields = ["beforeInputTokens", "afterInputTokens", "beforeBytes", "afterBytes"]
  if (!numberFields.every(field => Number.isSafeInteger(row[field]) && Number(row[field]) >= 0)) return null
  if (typeof row.stepId !== "string" || row.stepId.length === 0 || row.stepId.length > 256 || typeof row.idempotencyKey !== "string" || row.idempotencyKey.length === 0 || row.idempotencyKey.length > 256) return null
  if (row.status === "failed" && row.errorCode !== "context_compaction_failed") return null
  if (row.status !== "failed" && row.errorCode !== undefined) return null
  if (row.status === "compacted" && (typeof row.snapshotRef !== "string" || row.snapshotRef.length === 0 || row.snapshotRef.length > 256)) return null
  if (row.status !== "compacted" && row.snapshotRef !== undefined) return null
  const { observationId: _observationId, ...content } = row
  return { id: row.observationId, content: content as ContextCompactionObservation["content"] }
}
