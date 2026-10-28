import { types as nodeTypes } from "node:util"
import { TASK_GRAPH_LIMITS } from "./planning/task-graph.js"
import type { TaskGraphFinalSummary } from "./subagents/task-graph-final-summary.js"
import type { TaskGraphCurrentNode } from "./subagents/task-graph-command-port.js"

type Counts = TaskGraphFinalSummary["counts"]
type Count = Counts["discoveredJobs"]
type Coverage = Count["coverage"]
type ScoutOverlap = Readonly<{
  coverage: Coverage
  scouts: readonly Readonly<{
    key: string
    taskStatus: TaskGraphCurrentNode["status"]
    resultCoverage: Coverage
    reportedCount: number | null
    sharedCount: number | null
  }>[]
}>
const MAX_SERIALIZED_CHARS = 1_000
const CATEGORIES = ["analyzedJobs", "artifactReferences", "discoveredJobs", "prepareJobs", "reviewOutcomes"] as const
const COUNT_KEYS = ["coverage", "knownCount"] as const
const OVERLAP_COVERAGES = ["complete", "partial", "unavailable", "not_requested"] as const

/** Projects only revision-matched count facts; unsafe or stale envelopes are omitted. */
export function projectTaskGraphPlanningCounts(value: unknown, currentRevision: number): Counts | null {
  try {
    if (!Number.isSafeInteger(currentRevision) || currentRevision < 0) return null
    const facts = planningFactsRecord(value)
    if (!facts || facts.graphRevision !== currentRevision) return null
    const counts = exactDataRecord(facts.counts, CATEGORIES)
    if (!counts) return null
    const projected = {
      discoveredJobs: projectCount(counts.discoveredJobs),
      analyzedJobs: projectCount(counts.analyzedJobs),
      prepareJobs: projectCount(counts.prepareJobs),
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

/** Projects graph-local Scout overlap after binding every row to a current Scout node. */
export function projectTaskGraphPlanningScoutOverlap(
  value: unknown,
  currentRevision: number,
  nodes: readonly TaskGraphCurrentNode[],
): ScoutOverlap | null {
  try {
    if (!Number.isSafeInteger(currentRevision) || currentRevision < 0) return null
    const facts = planningFactsRecord(value)
    if (!facts || facts.graphRevision !== currentRevision || !Object.hasOwn(facts, "scoutOverlap")) return null
    const overlap = exactDataRecord(facts.scoutOverlap, ["coverage", "scouts"])
    if (!overlap || !isCoverage(overlap.coverage) || !isDenseArray(overlap.scouts)
      || overlap.scouts.length > TASK_GRAPH_LIMITS.maxNodes || nodes.length > TASK_GRAPH_LIMITS.maxNodes) return null
    const currentScouts = nodes.filter(node => node.templateId === "scout")
    if (new Set(currentScouts.map(node => node.key)).size !== currentScouts.length
      || currentScouts.some(node => !validNodeKey(node.key))) return null
    if (currentScouts.length === 0) {
      return overlap.coverage === "not_requested" && overlap.scouts.length === 0
        ? { coverage: "not_requested", scouts: [] }
        : null
    }
    if (overlap.coverage === "not_requested" || overlap.scouts.length !== currentScouts.length) return null
    const expected = new Map(currentScouts.map(node => [node.key, node]))
    const seen = new Set<string>()
    const rows = overlap.scouts.map(value => {
      const row = exactDataRecord(value, ["key", "taskStatus", "resultStatus", "resultCoverage", "reportedCount", "sharedCount"])
      if (!row || !validNodeKey(row.key) || !expected.has(row.key) || seen.has(row.key)) return null
      const node = expected.get(row.key)!
      if (row.taskStatus !== node.status || !isCoverage(row.resultCoverage)
        || !(row.resultStatus === "completed" || row.resultStatus === "partial" || row.resultStatus === null)
        || !validOptionalCount(row.reportedCount) || !validOptionalCount(row.sharedCount)) return null
      const available = row.resultCoverage === "complete" || row.resultCoverage === "partial"
      if (row.resultCoverage === "complete" && (row.resultStatus !== "completed" || !isCount(row.reportedCount) || !isCount(row.sharedCount))) return null
      if (row.resultCoverage === "partial" && (row.resultStatus !== "partial" || !isCount(row.reportedCount) || !isCount(row.sharedCount))) return null
      if (row.resultCoverage === "unavailable" && (row.resultStatus !== null || row.reportedCount !== null || row.sharedCount !== null)) return null
      if (row.resultCoverage === "not_requested" || !isTerminalTaskStatus(node.status) && available
        || isCount(row.sharedCount) && isCount(row.reportedCount) && row.sharedCount > row.reportedCount) return null
      seen.add(row.key)
      return { key: row.key, taskStatus: node.status, resultCoverage: row.resultCoverage, reportedCount: row.reportedCount, sharedCount: row.sharedCount }
    })
    if (rows.some(row => row === null)) return null
    const projectedRows = currentScouts.map(node => rows.find(row => row?.key === node.key)!)
    const hasAvailable = projectedRows.some(row => row.resultCoverage !== "unavailable")
    const allComplete = projectedRows.every(row => row.taskStatus === "completed" && row.resultCoverage === "complete")
    const anyNonComplete = projectedRows.some(row => row.taskStatus !== "completed" || row.resultCoverage !== "complete")
    const expectedCoverage: Coverage = !hasAvailable ? "unavailable" : allComplete ? "complete" : anyNonComplete ? "partial" : "complete"
    return overlap.coverage === expectedCoverage ? { coverage: expectedCoverage, scouts: projectedRows } : null
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

/** Adds optional Scout overlap last so an overflow cannot discard counts or capacity. */
export function withTaskGraphPlanningScoutOverlap<T extends Record<string, unknown>>(
  baseContent: T,
  overlap: ScoutOverlap | null,
  maxChars: number,
): T | (T & { taskReportedScoutOverlap: ScoutOverlap }) {
  if (!overlap) return baseContent
  try {
    const candidate = { ...baseContent, taskReportedScoutOverlap: overlap }
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

function planningFactsRecord(value: unknown): Record<string, unknown> | null {
  const facts = exactDataRecord(value, ["counts", "graphRevision"], ["scoutOverlap"])
  return facts && Number.isSafeInteger(facts.graphRevision) && Number(facts.graphRevision) >= 0 ? facts : null
}

function exactDataRecord(value: unknown, expectedKeys: readonly string[], optionalKeys: readonly string[] = []): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value) || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== "string") || expectedKeys.some(key => !keys.includes(key))
    || keys.some(key => ![...expectedKeys, ...optionalKeys].includes(String(key)))) return null
  const output = Object.create(null) as Record<string, unknown>
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return null
    output[key] = descriptor.value
  }
  return output
}

function validNodeKey(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= TASK_GRAPH_LIMITS.maxKeyLength
}

function isCoverage(value: unknown): value is Coverage {
  return typeof value === "string" && (OVERLAP_COVERAGES as readonly string[]).includes(value)
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function validOptionalCount(value: unknown): value is number | null {
  return value === null || isCount(value)
}

function isTerminalTaskStatus(status: TaskGraphCurrentNode["status"]): boolean {
  return status === "completed" || status === "failed" || status === "interrupted" || status === "cancelled" || status === "closed"
}

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Reflect.ownKeys(value).length !== value.length + 1) return false
  return Reflect.ownKeys(value).every(key => key === "length" || typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length)
}
