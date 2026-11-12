import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import { parseArtifactReference, type ArtifactVersionReference } from "./role-results.js"
import type { TaskGraphFinalSummaryBinding, TaskGraphFinalSummaryMember } from "./task-graph-final-summary-binding.js"
import type { TaskGraphFinalSummary } from "./task-graph-final-summary.js"

const MAX_NODES = TASK_GRAPH_LIMITS.maxPersistedNodes
const MAX_ROWS = MAX_NODES * 102
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const ROLES = ["analyst", "prepare", "reviewer", "scout", "writer", "unsupported"] as const
const TASK_STATES = ["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"] as const
const RESULT_STATES = ["valid", "missing", "invalid", "unsupported_role", "not_terminal"] as const
const REVIEWS = ["passed", "needs_revision", "rejected", "stale"] as const
type Outcome = TaskGraphFinalSummary["taskOutcomes"][number]

export type TaskGraphFollowUpFacts = Readonly<{ summary: TaskGraphFinalSummary; outcomes: ReadonlyMap<string, Outcome> }>

/** Validates private identity, membership, and summary provenance without claiming DB freshness. */
export function validateTaskGraphFollowUpBinding(value: unknown): TaskGraphFollowUpFacts | null {
  try {
    const binding = record(value)
    if (!binding || !exact(binding, "graphItemId,graphRevision,members,rootTaskId,summary")
      || !id(binding.rootTaskId) || !id(binding.graphItemId) || !positive(binding.graphRevision)) return null
    const members = dense(binding.members, MAX_NODES), summary = record(binding.summary)
    if (!members || !summary || !exact(summary, "analyzedJobs,artifactReferences,counts,discoveredJobs,graphRevision,prepareResults,reviewOutcomes,taskOutcomes")
      || summary.graphRevision !== binding.graphRevision) return null
    const byId = new Map<string, TaskGraphFinalSummaryMember>(), nodeKeys = new Set<string>()
    for (let index = 0; index < members.length; index++) {
      const member = record(members[index])
      if (!member || !exact(member, "kind,nodeIndex,nodeKey,role,taskId,taskStatus,taskType,templateId") || member.nodeIndex !== index
        || !boundedText(member.nodeKey, TASK_GRAPH_LIMITS.maxKeyLength) || !boundedText(member.templateId, TASK_GRAPH_LIMITS.maxTemplateIdLength)
        || !id(member.taskId, 80) || !text(member.role, 64) || !text(member.taskType, 128)
        || !TASK_STATES.includes(member.taskStatus as typeof TASK_STATES[number])
        || member.kind !== (member.role === "auditor" && member.taskType === "native_verification" ? "internal_control" : "business")
        || byId.has(member.taskId) || nodeKeys.has(member.nodeKey)) return null
      byId.set(member.taskId as string, member as unknown as TaskGraphFinalSummaryMember)
      nodeKeys.add(member.nodeKey as string)
    }
    const outcomes = readOutcomes(summary.taskOutcomes, byId)
    if (!outcomes || !validSummary(summary as unknown as TaskGraphFinalSummary, outcomes)) return null
    return { summary: summary as unknown as TaskGraphFinalSummary, outcomes }
  } catch { return null }
}

function readOutcomes(value: unknown, members: ReadonlyMap<string, TaskGraphFinalSummaryMember>): Map<string, Outcome> | null {
  const rows = dense(value, MAX_NODES), expected = [...members.values()].filter(member => member.kind === "business")
  if (!rows || rows.length !== expected.length) return null
  const result = new Map<string, Outcome>()
  for (const value of rows) {
    const row = record(value), hasRoleStatus = !!row && Object.hasOwn(row, "roleResultStatus")
    const fields = hasRoleStatus ? "resultState,role,roleResultStatus,taskId,taskStatus" : "resultState,role,taskId,taskStatus"
    if (!row || !exact(row, fields) || !id(row.taskId, 80) || !ROLES.includes(row.role as typeof ROLES[number])
      || !TASK_STATES.includes(row.taskStatus as typeof TASK_STATES[number]) || !RESULT_STATES.includes(row.resultState as typeof RESULT_STATES[number])
      || hasRoleStatus && !["completed", "partial"].includes(String(row.roleResultStatus))) return null
    const member = members.get(row.taskId as string)
    if (!member || member.kind !== "business" || result.has(row.taskId as string)
      || row.role !== (knownRole(member.role) ? member.role : "unsupported") || row.taskStatus !== member.taskStatus
      || (row.resultState === "valid") !== hasRoleStatus
      || row.resultState === "valid" && (!knownRole(row.role) || !terminal(row.taskStatus))) return null
    if (knownRole(row.role) ? row.resultState === "unsupported_role" || !terminal(row.taskStatus) && row.resultState !== "not_terminal"
      || terminal(row.taskStatus) && row.resultState === "not_terminal" : row.resultState !== "unsupported_role") return null
    result.set(row.taskId as string, row as unknown as Outcome)
  }
  return result
}

function validSummary(summary: TaskGraphFinalSummary, outcomes: ReadonlyMap<string, Outcome>): boolean {
  const discovered = dense(summary.discoveredJobs, MAX_ROWS), analyzed = dense(summary.analyzedJobs, MAX_ROWS)
  const prepares = dense(summary.prepareResults, MAX_NODES), artifacts = dense(summary.artifactReferences, MAX_ROWS), reviews = dense(summary.reviewOutcomes, MAX_ROWS)
  if (!discovered || !analyzed || !prepares || !artifacts || !reviews
    || !validCounts(summary.counts, outcomes, discovered.length, analyzed.length, prepares, artifacts.length, reviews.length)) return false
  const seenJobs = new Set<string>()
  for (const value of discovered) {
    const row = record(value), ids = row && taskIds(row.taskIds, outcomes, "scout")
    if (!row || !exact(row, "jobId,taskIds") || !id(row.jobId, 80) || !ids?.length || seenJobs.has(row.jobId as string)) return false
    seenJobs.add(row.jobId as string)
  }
  seenJobs.clear()
  for (const value of analyzed) {
    const row = record(value), findings = row && dense(row.findings, MAX_NODES * 100)
    if (!row || !exact(row, "findings,jobId") || !id(row.jobId, 80) || !findings?.length || seenJobs.has(row.jobId as string)) return false
    seenJobs.add(row.jobId as string)
    const pairs = new Set<string>()
    for (const value of findings) {
      const finding = record(value), taskId = finding?.taskId
      if (!finding || !exact(finding, "score,taskId") || !id(taskId, 80) || typeof finding.score !== "number"
        || !Number.isFinite(finding.score) || finding.score < 0 || finding.score > 10 || !taskRole(outcomes, taskId, "analyst")) return false
      const pair = taskId + ":" + finding.score
      if (pairs.has(pair)) return false
      pairs.add(pair)
    }
  }
  const prepareRefs = new Set<string>(), prepareTasks = new Set<string>()
  for (const value of prepares) if (!validPrepareRow(value, outcomes, prepareTasks, prepareRefs)) return false
  if ([...outcomes.values()].filter(item => item.role === "prepare" && item.resultState === "valid").length !== prepareTasks.size) return false
  const artifactRows = new Map<string, { artifactRef: ArtifactVersionReference; taskIds: readonly string[] }>(), versionDigests = new Map<string, string>(), refsPerTask = new Map<string, number>(), linkedPrepareRefs = new Set<string>()
  for (const value of artifacts) {
    const row = record(value), ref = row && safeArtifact(row.artifactRef), ids = row && taskIds(row.taskIds, outcomes)
    if (!row || !exact(row, "artifactRef,taskIds") || !ref || !ids?.length) return false
    const refKey = artifactKey(ref), versionKey = ref.artifactId + ":" + ref.version, digests = ref.contentHash + ":" + ref.sourceDigest
    if (artifactRows.has(refKey) || versionDigests.has(versionKey) && versionDigests.get(versionKey) !== digests) return false
    versionDigests.set(versionKey, digests)
    for (const taskId of ids) {
      const role = outcomes.get(taskId)?.role
      const prepareKey = taskId + ":" + refKey
      if (!["writer", "reviewer", "prepare"].includes(String(role)) || role === "prepare" && !prepareRefs.has(prepareKey)) return false
      if (role === "prepare") linkedPrepareRefs.add(prepareKey)
      refsPerTask.set(taskId, (refsPerTask.get(taskId) ?? 0) + 1)
    }
    artifactRows.set(refKey, { artifactRef: ref, taskIds: ids })
  }
  if (linkedPrepareRefs.size !== prepareRefs.size) return false
  const reviewTasks = new Set<string>(), reviewKeys = new Set<string>()
  for (const value of reviews) {
    const row = record(value), ref = row && safeArtifact(row.artifactRef), ids = row && taskIds(row.taskIds, outcomes, "reviewer")
    if (!row || !exact(row, "artifactRef,reviewStatus,taskIds") || !ref || !ids?.length || !REVIEWS.includes(row.reviewStatus as typeof REVIEWS[number])) return false
    const refKey = artifactKey(ref), reviewKey = refKey + ":" + row.reviewStatus
    if (!artifactRows.has(refKey) || ids.some(id => !artifactRows.get(refKey)?.taskIds.includes(id)) || reviewKeys.has(reviewKey) || ids.some(id => reviewTasks.has(id))) return false
    reviewKeys.add(reviewKey); for (const taskId of ids) reviewTasks.add(taskId)
  }
  for (const outcome of outcomes.values()) if (outcome.resultState === "valid") {
    if (outcome.role === "writer" && refsPerTask.get(outcome.taskId) !== 1) return false
    if (outcome.role === "reviewer" && (refsPerTask.get(outcome.taskId) !== 1 || !reviewTasks.has(outcome.taskId))) return false
    if (outcome.role === "prepare" && !prepareTasks.has(outcome.taskId)) return false
  }
  return true
}

function validPrepareRow(value: unknown, outcomes: ReadonlyMap<string, Outcome>, tasks: Set<string>, refs: Set<string>): boolean {
  const row = record(value), jobs = row && dense(row.jobs, 50)
  if (!row || !exact(row, "attemptCount,checkpointDigest,jobs,resultStatus,snapshotDigest,taskId") || !id(row.taskId, 80)
    || !positive(row.attemptCount) || !digest(row.snapshotDigest, true) || !digest(row.checkpointDigest, false)
    || !["completed", "partial"].includes(String(row.resultStatus)) || tasks.has(row.taskId as string)
    || !taskRole(outcomes, row.taskId as string, "prepare") || outcomes.get(row.taskId as string)?.roleResultStatus !== row.resultStatus || !jobs) return false
  tasks.add(row.taskId as string)
  const seenJobs = new Set<string>(); let hasFailure = false, materialCount = 0
  for (const value of jobs) {
    const job = record(value), materials = job && dense(job.materials, 100)
    if (!job || !exact(job, "jobId,materials,status") || !id(job.jobId, 80) || !["prepared", "skipped", "failed"].includes(String(job.status))
      || seenJobs.has(job.jobId as string) || !materials) return false
    seenJobs.add(job.jobId as string); hasFailure ||= job.status === "failed"
    const kinds = new Set<string>()
    for (const value of materials) {
      const material = record(value), ref = material && safeArtifact(material.artifactRef)
      if (!material || !exact(material, "artifactRef,kind") || !["resume", "cover_letter"].includes(String(material.kind))
        || job.status !== "prepared" || kinds.has(String(material.kind)) || !ref) return false
      kinds.add(material.kind as string); materialCount += 1
      refs.add(row.taskId + ":" + artifactKey(ref))
    }
  }
  return materialCount <= 100 && (row.resultStatus === "partial") === hasFailure
}

function validCounts(value: unknown, outcomes: ReadonlyMap<string, Outcome>, discovered: number, analyzed: number, prepares: readonly unknown[], artifacts: number, reviews: number): boolean {
  const counts = record(value)
  if (!counts || !exact(counts, "analyzedJobs,artifactReferences,discoveredJobs,prepareJobs,reviewOutcomes")) return false
  const jobs = prepares.reduce<number>((sum, value) => { const row = record(value), items = row && dense(row.jobs, 50); return sum + (items?.length ?? 0) }, 0)
  return countMatches(counts.discoveredJobs, roleOutcomes(outcomes, "scout"), discovered)
    && countMatches(counts.analyzedJobs, roleOutcomes(outcomes, "analyst"), analyzed)
    && countMatches(counts.prepareJobs, roleOutcomes(outcomes, "prepare"), jobs)
    && countMatches(counts.artifactReferences, [...outcomes.values()].filter(item => ["writer", "reviewer", "prepare"].includes(item.role)), artifacts)
    && countMatches(counts.reviewOutcomes, roleOutcomes(outcomes, "reviewer"), reviews)
}
function countMatches(value: unknown, tasks: readonly Outcome[], observed: number): boolean {
  const count = record(value)
  if (!count || !exact(count, "coverage,knownCount")) return false
  const coverage = tasks.length === 0 ? "not_requested" : tasks.every(task => task.taskStatus === "completed" && task.resultState === "valid" && task.roleResultStatus === "completed")
    ? "complete" : tasks.some(task => task.resultState === "valid") ? "partial" : "unavailable"
  return count.coverage === coverage && count.knownCount === (coverage === "complete" || coverage === "partial" ? observed : null)
    && (coverage === "complete" || coverage === "partial" || observed === 0)
}
function taskIds(value: unknown, outcomes: ReadonlyMap<string, Outcome>, role?: string): string[] | null {
  const rows = dense(value, MAX_NODES)
  return !rows || rows.some(id => typeof id !== "string" || !taskRole(outcomes, id, role)) || new Set(rows).size !== rows.length ? null : rows as string[]
}
function taskRole(outcomes: ReadonlyMap<string, Outcome>, taskId: string, role?: string): boolean { const outcome = outcomes.get(taskId); return !!outcome && (!role || outcome.role === role) && outcome.resultState === "valid" }
function roleOutcomes(outcomes: ReadonlyMap<string, Outcome>, role: string): Outcome[] { return [...outcomes.values()].filter(outcome => outcome.role === role) }
function safeArtifact(value: unknown): ArtifactVersionReference | null { try { return parseArtifactReference(value) } catch { return null } }
function artifactKey(ref: ArtifactVersionReference): string { return JSON.stringify([ref.artifactId, ref.version, ref.contentHash, ref.sourceDigest]) }
function knownRole(value: unknown): value is Exclude<typeof ROLES[number], "unsupported"> { return typeof value === "string" && ["analyst", "prepare", "reviewer", "scout", "writer"].includes(value) }
function terminal(value: unknown): boolean { return ["completed", "failed", "interrupted", "cancelled", "closed"].includes(String(value)) }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function digest(value: unknown, prefix: boolean): boolean { return typeof value === "string" && (prefix ? /^sha256:[a-f0-9]{64}$/.test(value) : /^[a-f0-9]{64}$/.test(value)) }
function id(value: unknown, max = 128): value is string { return typeof value === "string" && value.length > 0 && value.length <= max && IDENTIFIER.test(value) }
function boundedText(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max }
function text(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value }
function dense(value: unknown, maximum: number): unknown[] | null {
  if (!Array.isArray(value) || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) return null
  return Reflect.ownKeys(value).every(key => key === "length" || typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length) ? value : null
}
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try { const keys = Reflect.ownKeys(value); return ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || keys.some(key => typeof key !== "string"
    || !Object.getOwnPropertyDescriptor(value, key)?.enumerable || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value")) ? null : value as Record<string, unknown> } catch { return null }
}
function exact(value: Record<string, unknown>, keys: string): boolean { return Reflect.ownKeys(value).sort().join(",") === keys }
