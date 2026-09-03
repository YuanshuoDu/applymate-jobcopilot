import type { TenantScope } from "@jobcopilot/agent-protocol"

import type { CompactionItemRecord, CompactionSnapshotDraft } from "./context-compaction-types.js"

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
