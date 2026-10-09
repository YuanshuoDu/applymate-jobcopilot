import { types as nodeTypes } from "node:util"
import type { TaskGraphFinalSummary } from "./subagents/task-graph-final-summary.js"

type Counts = TaskGraphFinalSummary["counts"]
type Count = Counts["discoveredJobs"]
const MAX_SERIALIZED_CHARS = 1_000
const CATEGORIES = ["analyzedJobs", "artifactReferences", "discoveredJobs", "reviewOutcomes"] as const
const COUNT_KEYS = ["coverage", "knownCount"] as const

/** Projects only revision-matched count facts; unsafe or stale envelopes are omitted. */
export function projectTaskGraphPlanningCounts(value: unknown, currentRevision: number): Counts | null {
  try {
    if (!Number.isSafeInteger(currentRevision) || currentRevision < 0) return null
    const facts = exactDataRecord(value, ["counts", "graphRevision"])
    if (!facts || facts.graphRevision !== currentRevision) return null
    const counts = exactDataRecord(facts.counts, CATEGORIES)
    if (!counts) return null
    const projected = {
      discoveredJobs: projectCount(counts.discoveredJobs),
      analyzedJobs: projectCount(counts.analyzedJobs),
      artifactReferences: projectCount(counts.artifactReferences),
      reviewOutcomes: projectCount(counts.reviewOutcomes),
    }
    if (Object.values(projected).some(count => count === null)) return null
    const output = projected as Counts
    const serialized = JSON.stringify(output)
    return serialized.length <= MAX_SERIALIZED_CHARS ? output : null
  } catch {
    return null
  }
}

/** Adds optional counts only when they fit without changing the base observation. */
export function withTaskGraphPlanningCounts<T extends Record<string, unknown>>(
  baseContent: T,
  counts: Counts | null,
  maxChars: number,
): T | (T & { taskReportedCounts: Counts }) {
  if (!counts) return baseContent
  try {
    const candidate = { ...baseContent, taskReportedCounts: counts }
    const serialized = JSON.stringify(candidate)
    return serialized && serialized.length <= maxChars ? candidate : baseContent
  } catch {
    return baseContent
  }
}

function projectCount(value: unknown): Count | null {
  const row = exactDataRecord(value, COUNT_KEYS)
  if (!row || typeof row.coverage !== "string") return null
  const { coverage, knownCount } = row
  if ((coverage === "complete" || coverage === "partial")
    && typeof knownCount === "number" && Number.isSafeInteger(knownCount) && knownCount >= 0) {
    return { knownCount, coverage }
  }
  if ((coverage === "unavailable" || coverage === "not_requested") && knownCount === null) {
    return { knownCount: null, coverage }
  }
  return null
}

function exactDataRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value) || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const keys = Reflect.ownKeys(value)
  if (keys.length !== expectedKeys.length || keys.some(key => typeof key !== "string")
    || (keys as string[]).sort().join("\0") !== [...expectedKeys].sort().join("\0")) return null
  const output = Object.create(null) as Record<string, unknown>
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return null
    output[key] = descriptor.value
  }
  return output
}
