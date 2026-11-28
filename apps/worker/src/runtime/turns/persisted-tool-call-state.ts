import { restoreToolCallState as restoreSharedToolCallState } from "@jobcopilot/shared/task-graph-tool-receipt-verification"
import type { PersistedToolCallRecovery } from "./turn-engine-types.js"
import { readDependencyWaitBatchRejection } from "./dependency-wait-batch-rejection.js"

type Row = Record<string, unknown>
type ToolObservation = { readonly id: string; readonly content: Record<string, unknown> }

export function restoreToolCallState(items: readonly Row[], events: readonly Row[]): {
  readonly observations: readonly ToolObservation[]
  readonly pending: readonly PersistedToolCallRecovery[]
} {
  return restoreSharedToolCallState(items, events, { resolveMarkedResult: readDependencyWaitBatchRejection })
}
