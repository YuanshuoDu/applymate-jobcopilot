import {
  CompactionError,
  type CompactionTriggerDecision,
  type CompactionTriggerInput,
  type CompactionTriggerPolicy,
} from "./context-compaction-types.js"

export const DEFAULT_COMPACTION_POLICY: CompactionTriggerPolicy = {
  inputTokenThreshold: 12_000,
  itemCountThreshold: 100,
  compactAtTurnBoundary: true,
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new CompactionError("invalid_policy", `${field} must be a positive safe integer`)
  return value
}

function validatePolicy(policy: CompactionTriggerPolicy): void {
  positiveInteger(policy.inputTokenThreshold, "inputTokenThreshold")
  positiveInteger(policy.itemCountThreshold, "itemCountThreshold")
  if (typeof policy.compactAtTurnBoundary !== "boolean") throw new CompactionError("invalid_policy", "compactAtTurnBoundary must be boolean")
}

export function evaluateCompactionTrigger(input: CompactionTriggerInput, policy: CompactionTriggerPolicy): CompactionTriggerDecision {
  validatePolicy(policy)
  if (!Number.isSafeInteger(input.inputTokens) || input.inputTokens < 0) throw new CompactionError("invalid_source", "inputTokens must be non-negative")
  if (!Number.isSafeInteger(input.itemCount) || input.itemCount < 0) throw new CompactionError("invalid_source", "itemCount must be non-negative")
  if (input.requested) return { shouldCompact: true, reason: "manual" }
  if (input.inputTokens >= policy.inputTokenThreshold && input.itemCount > 0) return { shouldCompact: true, reason: "input_tokens" }
  if (input.itemCount >= policy.itemCountThreshold) return { shouldCompact: true, reason: "item_count" }
  if (policy.compactAtTurnBoundary && input.atTurnBoundary && input.itemCount > 0) return { shouldCompact: true, reason: "turn_boundary" }
  return { shouldCompact: false, reason: null }
}
