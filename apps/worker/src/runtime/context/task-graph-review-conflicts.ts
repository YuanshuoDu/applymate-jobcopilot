import { Buffer } from "node:buffer"
import type { TaskGraphCurrentNode } from "../subagents/task-graph-command-port.js"

export type TaskGraphReviewStatus = "passed" | "needs_revision" | "rejected" | "stale"
export type TaskGraphReviewConflict = Readonly<{
  artifactId: string
  version: number
  outcomes: readonly Readonly<{ taskId: string; reviewStatus: TaskGraphReviewStatus }>[]
  truncated: boolean
}>

const MAX_GROUPS = 4
const MAX_OUTCOMES_PER_GROUP = 8
const MAX_CONFLICT_FIELD_BYTES = 4 * 1024
const RESULT_PROJECTION_SCHEMA = "agent-harness.v2.task-graph.result-projection"
const REVIEW_STATUSES = new Set<TaskGraphReviewStatus>(["passed", "needs_revision", "rejected", "stale"])
const SAFE_ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_SHA256 = /^sha256:[a-f0-9]{64}$/

type ArtifactReference = Readonly<{ artifactId: string; version: number; contentHash: string; sourceDigest: string }>
type ReviewOutcome = Readonly<{ artifactRef: ArtifactReference; taskId: string; reviewStatus: TaskGraphReviewStatus }>
type ReviewGroup = { artifactRef: ArtifactReference; byTask: Map<string, Set<TaskGraphReviewStatus>> }

/** Adds a bounded, hash-free conflict DTO only when validated current reviewers disagree. */
export function taskGraphReviewConflictObservation(nodes: readonly TaskGraphCurrentNode[]): Readonly<{
  reviewConflicts?: readonly TaskGraphReviewConflict[]
}> {
  const groups = new Map<string, ReviewGroup>()
  for (const node of nodes) {
    const outcome = reviewerOutcome(node)
    if (!outcome) continue
    const key = artifactKey(outcome.artifactRef)
    const group = groups.get(key) ?? { artifactRef: outcome.artifactRef, byTask: new Map<string, Set<TaskGraphReviewStatus>>() }
    const statuses = group.byTask.get(outcome.taskId) ?? new Set<TaskGraphReviewStatus>()
    statuses.add(outcome.reviewStatus)
    group.byTask.set(outcome.taskId, statuses)
    groups.set(key, group)
  }

  const candidates = [...groups.values()].flatMap(group => {
    if ([...group.byTask.values()].some(statuses => statuses.size > 1)) return []
    const outcomes = [...group.byTask].flatMap(([taskId, statuses]) => {
      const reviewStatus = [...statuses][0]
      return reviewStatus ? [{ taskId, reviewStatus }] : []
    }).sort(compareOutcome)
    if (group.byTask.size < 2 || new Set(outcomes.map(item => item.reviewStatus)).size < 2) return []
    const bounded = boundOutcomes(outcomes)
    return [{ identity: group.artifactRef, conflict: {
      artifactId: group.artifactRef.artifactId, version: group.artifactRef.version,
      outcomes: bounded.outcomes, truncated: bounded.truncated,
    } satisfies TaskGraphReviewConflict }]
  }).sort((left, right) => compareArtifact(left.identity, right.identity))

  const included: TaskGraphReviewConflict[] = []
  for (const candidate of candidates.slice(0, MAX_GROUPS)) {
    const next = [...included, candidate.conflict]
    if (Buffer.byteLength(JSON.stringify({ reviewConflicts: next }), "utf8") > MAX_CONFLICT_FIELD_BYTES) break
    included.push(candidate.conflict)
  }
  return included.length ? { reviewConflicts: included } : {}
}

function reviewerOutcome(value: unknown): ReviewOutcome | null {
  try {
    const node = record(value), projection = record(node?.resultProjection)
    if (!node || node.status !== "completed" || typeof node.taskId !== "string" || !node.taskId.trim() || node.taskId.length > 128
      || !projection || !exactKeys(projection, "artifactRef,availability,reviewHash,reviewStatus,role,schemaVersion,status,trust")
      || projection.schemaVersion !== RESULT_PROJECTION_SCHEMA || projection.trust !== "untrusted"
      || projection.availability !== "available" || projection.role !== "reviewer" || projection.status !== "completed"
      || typeof projection.reviewStatus !== "string" || !REVIEW_STATUSES.has(projection.reviewStatus as TaskGraphReviewStatus)
      || typeof projection.reviewHash !== "string" || !SAFE_SHA256.test(projection.reviewHash)) return null
    const reference = record(projection.artifactRef)
    if (!reference || !exactKeys(reference, "artifactId,contentHash,sourceDigest,version")
      || typeof reference.artifactId !== "string" || !SAFE_ARTIFACT_ID.test(reference.artifactId)
      || !Number.isSafeInteger(reference.version) || Number(reference.version) < 1
      || typeof reference.contentHash !== "string" || !SAFE_SHA256.test(reference.contentHash)
      || typeof reference.sourceDigest !== "string" || !SAFE_SHA256.test(reference.sourceDigest)) return null
    return {
      taskId: node.taskId, reviewStatus: projection.reviewStatus as TaskGraphReviewStatus,
      artifactRef: { artifactId: reference.artifactId, version: Number(reference.version),
        contentHash: reference.contentHash, sourceDigest: reference.sourceDigest },
    }
  } catch { return null }
}

function boundOutcomes(outcomes: readonly Readonly<{ taskId: string; reviewStatus: TaskGraphReviewStatus }>[]) {
  if (outcomes.length <= MAX_OUTCOMES_PER_GROUP) return { outcomes, truncated: false }
  const selected = new Map<string, Readonly<{ taskId: string; reviewStatus: TaskGraphReviewStatus }>>()
  for (const outcome of outcomes) if (![...selected.values()].some(item => item.reviewStatus === outcome.reviewStatus)) {
    selected.set(outcomeKey(outcome), outcome)
  }
  for (const outcome of outcomes) {
    if (selected.size >= MAX_OUTCOMES_PER_GROUP) break
    selected.set(outcomeKey(outcome), outcome)
  }
  return { outcomes: [...selected.values()].sort(compareOutcome), truncated: true }
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    return (prototype === Object.prototype || prototype === null) && Object.getOwnPropertySymbols(value).length === 0
      ? value as Record<string, unknown> : null
  } catch { return null }
}
function exactKeys(value: Record<string, unknown>, expected: string): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.every((key): key is string => typeof key === "string") && keys.sort().join(",") === expected
}
function artifactKey(value: ArtifactReference): string { return JSON.stringify([value.artifactId, value.version, value.contentHash, value.sourceDigest]) }
function compareArtifact(left: ArtifactReference, right: ArtifactReference): number {
  return compareText(left.artifactId, right.artifactId) || left.version - right.version
    || compareText(left.contentHash, right.contentHash) || compareText(left.sourceDigest, right.sourceDigest)
}
function outcomeKey(value: Readonly<{ taskId: string; reviewStatus: TaskGraphReviewStatus }>): string { return JSON.stringify([value.taskId, value.reviewStatus]) }
function compareOutcome(left: Readonly<{ taskId: string; reviewStatus: TaskGraphReviewStatus }>, right: Readonly<{ taskId: string; reviewStatus: TaskGraphReviewStatus }>): number {
  return compareText(left.reviewStatus, right.reviewStatus) || compareText(left.taskId, right.taskId)
}
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
