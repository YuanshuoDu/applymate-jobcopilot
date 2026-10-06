import type { TenantScope } from "@jobcopilot/agent-protocol"

import { parseSnapshotContent } from "./context-snapshot-canonical.js"
import type { SelectedJobMemoryRecord } from "./selected-job-memory.js"
import type { StepContextSnapshot } from "./step-context-builder.js"
import { stepContextSnapshotFromContent } from "./context-snapshot-working-state.js"

export type CanonicalTurnSnapshot = Readonly<{
  snapshot: StepContextSnapshot
  selectedJobMemories?: readonly SelectedJobMemoryRecord[]
}>

export function restoreCanonicalTurnSnapshot(
  value: unknown,
  throughSequence: unknown,
  scope: TenantScope,
  sessionId: string,
): CanonicalTurnSnapshot {
  const content = parseSnapshotContent(value)
  if (content.ownerId !== scope.userId || content.sessionId !== sessionId) throw new Error("context_snapshot_scope_mismatch")
  if (content.throughSequence !== String(throughSequence)) throw new Error("context_snapshot_sequence_mismatch")
  return {
    snapshot: stepContextSnapshotFromContent(content),
    ...(content.compaction?.state.selectedJobMemories ? { selectedJobMemories: content.compaction.state.selectedJobMemories } : {}),
  }
}
