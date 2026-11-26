import {
  OBJECTIVE_TAILOR_SOURCE_GROUPS_SCHEMA,
  parseObjectiveTailorSourceGroups,
  type ObjectiveTailorSourceGroups,
} from "@jobcopilot/agent-protocol"
import type { TaskGraphFinalSummaryBinding, TaskGraphFinalSummaryMember } from "./task-graph-final-summary-binding.js"
import { hasObjectiveTailorFinalOutcome, readBoundObjectiveTailorFinalOutcome } from "./objective-tailor-final-summary-binding.js"
import { buildTaskGraphFinalSourceManifest } from "./task-graph-final-source-manifest.js"

export type ObjectiveTailorSourceGroupsRead =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "ready"; groups: ObjectiveTailorSourceGroups }>

/** Reads the exact current Objective-only projection; ordinary summaries stay absent. */
export function readObjectiveTailorSourceGroups(binding: TaskGraphFinalSummaryBinding | undefined,
  finalItemId: string): ObjectiveTailorSourceGroupsRead {
  if (!binding || !hasObjectiveTailorFinalOutcome(binding)) return { status: "absent" }
  try {
    const groups = buildObjectiveTailorSourceGroups(binding, finalItemId)
    return groups ? { status: "ready", groups } : { status: "invalid" }
  } catch { return { status: "invalid" } }
}

export function objectiveTailorSourceGroupsValueMatches(read: ObjectiveTailorSourceGroupsRead, value: unknown): boolean {
  if (read.status === "absent") return value === undefined
  const parsed = parseObjectiveTailorSourceGroups(value)
  return read.status === "ready" && parsed !== undefined && sameGroups(read.groups, parsed)
}

/** Derives opaque item-bound selectors from reducer facts, never from role alone. */
export function buildObjectiveTailorSourceGroups(binding: TaskGraphFinalSummaryBinding,
  finalItemId: string): ObjectiveTailorSourceGroups | null {
  if (!hasObjectiveTailorFinalOutcome(binding)) return null
  const outcome = readBoundObjectiveTailorFinalOutcome(binding)
  if (!outcome || !strictRecord(binding) || !strictRecord(binding.summary)) throw new Error("objective_tailor_source_groups_binding_invalid")
  const members = strictArray(binding.members, 8)
  const summary = binding.summary
  const taskOutcomes = strictArray(summary.taskOutcomes, 8)
  if (!members || !taskOutcomes || members.length !== outcome.sourceNodeCount
    || binding.graphRevision !== outcome.graphRevision || summary.graphRevision !== binding.graphRevision) {
    throw new Error("objective_tailor_source_groups_binding_invalid")
  }
  const parsedMembers: TaskGraphFinalSummaryMember[] = [], memberByTask = new Map<string, TaskGraphFinalSummaryMember>()
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index]
    if (!validMember(member, index) || memberByTask.has(member.taskId)) throw new Error("objective_tailor_source_groups_member_invalid")
    parsedMembers.push(member)
    memberByTask.set(member.taskId, member)
  }
  const businessMembers = [...memberByTask.values()].filter(member => member.kind === "business")
  validateTaskOutcomes(taskOutcomes, new Map(businessMembers.map(member => [member.taskId, member])))
  const manifest = buildTaskGraphFinalSourceManifest(binding, finalItemId)
  if (!manifest || manifest.graphRevision !== binding.graphRevision || manifest.sources.length !== businessMembers.length) {
    throw new Error("objective_tailor_source_groups_manifest_invalid")
  }
  const sourceByIndex = new Map(manifest.sources.map(source => [source.nodeIndex, source] as const))
  const sourceByTask = new Map<string, SourceBinding>()
  for (const member of parsedMembers) {
    const source = sourceByIndex.get(member.nodeIndex)
    if (member.kind === "historical") {
      sourceByTask.set(member.taskId, { sourceKey: null, nodeIndex: member.nodeIndex, role: member.role, historical: true, eligible: false })
      continue
    }
    if (!source || source.role !== member.role) {
      throw new Error("objective_tailor_source_groups_source_invalid")
    }
    sourceByTask.set(member.taskId, { sourceKey: source.sourceKey, nodeIndex: member.nodeIndex, role: member.role,
      historical: false, eligible: source.resultState === "valid" && source.taskStatus === "completed" && member.taskStatus === "completed" })
  }
  const discovered = collectDiscovered(summary.discoveredJobs, sourceByTask)
  const analyzed = collectAnalyzed(summary.analyzedJobs, sourceByTask)
  reconcileCount(summary.counts?.discoveredJobs, summary.discoveredJobs, discovered)
  reconcileCount(summary.counts?.analyzedJobs, summary.analyzedJobs, analyzed)
  const parsed = parseObjectiveTailorSourceGroups({ schemaVersion: OBJECTIVE_TAILOR_SOURCE_GROUPS_SCHEMA,
    graphRevision: binding.graphRevision, groups: { discoveredJobs: discovered, analyzedJobs: analyzed } })
  if (!parsed) throw new Error("objective_tailor_source_groups_projection_invalid")
  return parsed
}

type SourceBinding = Readonly<{ sourceKey: string | null; nodeIndex: number; role: string; historical: boolean; eligible: boolean }>

function collectDiscovered(value: unknown, sources: ReadonlyMap<string, SourceBinding>): readonly string[] {
  const rows = strictArray(value, Number.MAX_SAFE_INTEGER)
  if (!rows) throw new Error("objective_tailor_source_groups_discovered_invalid")
  const jobs = new Set<string>(), keys = new Set<string>()
  for (const raw of rows) {
    const row = strictRecord(raw), taskIds = row && strictArray(row.taskIds, 8)
    if (!row || !exactKeys(row, ["jobId", "taskIds"]) || !safeText(row.jobId) || !taskIds || taskIds.length === 0) {
      throw new Error("objective_tailor_source_groups_discovered_invalid")
    }
    if (jobs.has(row.jobId)) throw new Error("objective_tailor_source_groups_discovered_duplicate")
    jobs.add(row.jobId)
    addSourceKeys(taskIds, sources, "scout", keys)
  }
  return orderedKeys(keys, sources)
}

function collectAnalyzed(value: unknown, sources: ReadonlyMap<string, SourceBinding>): readonly string[] {
  const rows = strictArray(value, Number.MAX_SAFE_INTEGER)
  if (!rows) throw new Error("objective_tailor_source_groups_analyzed_invalid")
  const jobs = new Set<string>(), findings = new Set<string>(), keys = new Set<string>()
  for (const raw of rows) {
    const row = strictRecord(raw), items = row && strictArray(row.findings, Number.MAX_SAFE_INTEGER)
    if (!row || !exactKeys(row, ["findings", "jobId"]) || !safeText(row.jobId) || !items || items.length === 0) {
      throw new Error("objective_tailor_source_groups_analyzed_invalid")
    }
    if (jobs.has(row.jobId)) throw new Error("objective_tailor_source_groups_analyzed_duplicate")
    jobs.add(row.jobId)
    for (const rawFinding of items) {
      const finding = strictRecord(rawFinding)
      if (!finding || !exactKeys(finding, ["score", "taskId"]) || !safeText(finding.taskId)
        || typeof finding.score !== "number" || !Number.isFinite(finding.score) || finding.score < 0 || finding.score > 10) {
        throw new Error("objective_tailor_source_groups_finding_invalid")
      }
      const findingKey = `${row.jobId}\u0000${finding.taskId}\u0000${finding.score}`
      if (findings.has(findingKey)) throw new Error("objective_tailor_source_groups_finding_duplicate")
      findings.add(findingKey)
      addSourceKeys([finding.taskId], sources, "analyst", keys)
    }
  }
  return orderedKeys(keys, sources)
}

function addSourceKeys(taskIds: readonly unknown[], sources: ReadonlyMap<string, SourceBinding>, role: string, keys: Set<string>): void {
  const seen = new Set<string>()
  for (const taskId of taskIds) {
    if (typeof taskId !== "string" || seen.has(taskId)) throw new Error("objective_tailor_source_groups_task_duplicate")
    seen.add(taskId)
    const source = sources.get(taskId)
    if (!source || source.role !== role || source.historical || !source.eligible || !source.sourceKey) {
      throw new Error("objective_tailor_source_groups_task_invalid")
    }
    keys.add(source.sourceKey)
  }
}

function orderedKeys(keys: ReadonlySet<string>, sources: ReadonlyMap<string, SourceBinding>): readonly string[] {
  return [...sources.values()].filter((source): source is SourceBinding & Readonly<{ sourceKey: string }> =>
    source.sourceKey !== null && keys.has(source.sourceKey)).sort((left, right) => left.nodeIndex - right.nodeIndex).map(source => source.sourceKey)
}

function reconcileCount(value: unknown, rows: unknown, keys: readonly string[]): void {
  const count = strictRecord(value), rowList = strictArray(rows, Number.MAX_SAFE_INTEGER)
  if (!count || !exactKeys(count, ["coverage", "knownCount"]) || !rowList) throw new Error("objective_tailor_source_groups_count_invalid")
  if (count.coverage === "complete" || count.coverage === "partial") {
    if (!nonnegativeSafeInteger(count.knownCount) || count.knownCount !== rowList.length
      || count.knownCount > 0 && keys.length === 0) throw new Error("objective_tailor_source_groups_count_mismatch")
    return
  }
  if ((count.coverage !== "unavailable" && count.coverage !== "not_requested") || count.knownCount !== null
    || rowList.length !== 0 || keys.length !== 0) throw new Error("objective_tailor_source_groups_count_mismatch")
}

function validateTaskOutcomes(rows: readonly unknown[], members: ReadonlyMap<string, TaskGraphFinalSummaryMember>): void {
  if (rows.length !== members.size) throw new Error("objective_tailor_source_groups_outcomes_invalid")
  const seen = new Set<string>()
  for (const raw of rows) {
    const row = strictRecord(raw), hasStatus = row && Object.hasOwn(row, "roleResultStatus")
    const validResult = row?.resultState === "valid"
      ? row.roleResultStatus === "completed" || row.roleResultStatus === "partial"
      : row && !hasStatus
    if (!row || !exactKeys(row, hasStatus ? ["role", "roleResultStatus", "resultState", "taskId", "taskStatus"] : ["role", "resultState", "taskId", "taskStatus"])
      || !safeText(row.taskId) || seen.has(row.taskId) || !validResult) {
      throw new Error("objective_tailor_source_groups_outcomes_invalid")
    }
    const member = members.get(row.taskId)
    if (!member || row.role !== member.role || row.taskStatus !== member.taskStatus) throw new Error("objective_tailor_source_groups_outcomes_invalid")
    seen.add(row.taskId)
  }
}

function validMember(value: unknown, index: number): value is TaskGraphFinalSummaryMember {
  const row = strictRecord(value)
  return !!row && exactKeys(row, ["kind", "nodeIndex", "nodeKey", "role", "taskId", "taskStatus", "taskType", "templateId"])
    && (row.kind === "business" || row.kind === "historical") && row.nodeIndex === index && row.templateId === row.role
    && (row.role === "scout" && row.taskType === "job_discovery" || row.role === "analyst" && row.taskType === "job_analysis")
    && (row.kind === "business" || row.taskStatus === "completed") && safeText(row.nodeKey) && safeText(row.taskId)
}

function sameGroups(left: ObjectiveTailorSourceGroups, right: ObjectiveTailorSourceGroups): boolean {
  return left.schemaVersion === right.schemaVersion && left.graphRevision === right.graphRevision
    && sameArray(left.groups.discoveredJobs, right.groups.discoveredJobs)
    && sameArray(left.groups.analyzedJobs, right.groups.analyzedJobs)
}
function sameArray(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]) }
function strictRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const keys = Reflect.ownKeys(value), prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null || keys.some(key => typeof key !== "string")) return undefined
    for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor?.enumerable || !("value" in descriptor)) return undefined }
    return value as Record<string, unknown>
  } catch { return undefined }
}
function strictArray(value: unknown, maximum: number): readonly unknown[] | undefined {
  if (!Array.isArray(value) || value.length > maximum) return undefined
  try {
    const keys = Reflect.ownKeys(value)
    if (Object.getPrototypeOf(value) !== Array.prototype || keys.length !== value.length + 1 || !keys.includes("length")) return undefined
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !("value" in descriptor)) return undefined
    }
    return value
  } catch { return undefined }
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.length === expected.length && keys.every(key => typeof key === "string" && expected.includes(key))
}
function safeText(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.trim() === value && value.length <= 512 }
function nonnegativeSafeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
