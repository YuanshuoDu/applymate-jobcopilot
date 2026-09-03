import { CompactionError, type CompactionInvariantField, type CompactionInvariantReport, type CompactionState } from "./context-compaction-types.js"
import { canonicalJson, sha256Hex } from "./context-compaction-canonical.js"

const requiredFields: readonly CompactionInvariantField[] = ["goal", "approvals", "answers", "artifact_hashes", "open_tasks", "do_not_repeat"]

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function projection(value: unknown): { readonly value: Record<string, unknown> | null; readonly missing: readonly string[] } {
  const input = record(value)
  if (!input) return { value: null, missing: ["state"] }
  const missing: string[] = []
  for (const field of ["goal", "approvals", "answers", "artifacts", "openTasks", "doNotRepeat"] as const) if (!(field in input)) missing.push(field)
  if (missing.length > 0) return { value: input, missing }
  const artifacts = Array.isArray(input.artifacts) ? input.artifacts.map((entry) => {
    const item = record(entry)
    return item ? { id: item.id, hash: item.hash } : entry
  }) : input.artifacts
  return {
    value: {
      goal: input.goal,
      approvals: input.approvals,
      answers: input.answers,
      artifact_hashes: artifacts,
      open_tasks: input.openTasks,
      do_not_repeat: input.doNotRepeat,
    },
    missing,
  }
}

function digest(value: Record<string, unknown> | null): string {
  if (!value) return "invalid"
  try { return sha256Hex(value) } catch { return "invalid" }
}

export function compareCompactionInvariants(before: unknown, after: unknown): CompactionInvariantReport {
  const left = projection(before)
  const right = projection(after)
  const missingFields = [...right.missing]
  const changedFields: CompactionInvariantField[] = []
  const preservedFields: CompactionInvariantField[] = []
  if (left.value && right.value) {
    const pairs: readonly [CompactionInvariantField, string][] = [["goal", "goal"], ["approvals", "approvals"], ["answers", "answers"], ["artifact_hashes", "artifact_hashes"], ["open_tasks", "open_tasks"], ["do_not_repeat", "do_not_repeat"]]
    for (const [field, key] of pairs) {
      if (left.value[key] === undefined) missingFields.push(`before.${key}`)
      else if (right.value[key] === undefined) missingFields.push(`after.${key}`)
      else {
        try {
          if (canonicalJson(left.value[key]) === canonicalJson(right.value[key])) preservedFields.push(field)
          else changedFields.push(field)
        } catch { changedFields.push(field) }
      }
    }
  }
  const uniqueMissing = [...new Set(missingFields)]
  return {
    preserved: uniqueMissing.length === 0 && changedFields.length === 0 && preservedFields.length === requiredFields.length,
    preservedFields,
    missingFields: uniqueMissing,
    changedFields,
    beforeDigest: digest(left.value),
    afterDigest: digest(right.value),
  }
}

export function assertCompactionInvariantsPreserved(before: CompactionState, after: CompactionState): CompactionInvariantReport {
  const report = compareCompactionInvariants(before, after)
  if (!report.preserved) throw new CompactionError("invariant_loss", "Compaction invariant comparison failed")
  return report
}
