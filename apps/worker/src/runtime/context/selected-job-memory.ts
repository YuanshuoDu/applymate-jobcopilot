import { Buffer } from "node:buffer"
import { sha256Hex } from "./context-compaction-canonical.js"
import {
  parseTaskGraphRepairOf, parseTaskGraphRepairReceipt, parseTaskGraphVerificationCriterionIds,
  parseTaskGraphVerificationReport, taskGraphVerificationReportMatchesStatus, TASK_GRAPH_RESULT_PROJECTION_SCHEMA,
  type TaskGraphCurrentState,
} from "../subagents/task-graph-command-port.js"
import type { TaskGraphVerificationReasonCode } from "../planning/task-graph-verification.js"
import type { SubagentTaskStatus } from "../subagents/types.js"
import type { StepContextSnapshot } from "./step-context-builder.js"

export const SELECTED_JOB_MEMORY_SCHEMA_VERSION = "agent-harness.selected-job-memory.v1" as const
const MAX_RECORDS = 8
const MAX_NODES = 8
const MAX_BYTES = 16 * 1024
const DIGEST = /^[a-f0-9]{64}$/
const SHA256 = /^sha256:[a-f0-9]{64}$/
const SEQUENCE = /^(0|[1-9][0-9]*)$/
const STATUSES = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"])
const READINESS = new Set(["ready", "waiting_for_dependencies", "blocked_dependency", "active", "terminal"])
const ROLES = new Map<string, SelectedJobMemoryNode["role"]>([["scout", "scout"], ["analyst", "analyst"], ["cover_letter_writer", "writer"], ["cover_letter_reviewer", "reviewer"]])
const SOURCES = new Set(["greenhouse", "lever", "workday", "smartrecruiters", "personio", "other"])
const EVIDENCE = new Set(["job", "persona", "resume", "source"])

export type SelectedJobMemoryResult =
  | Readonly<{ availability: "unavailable" }>
  | Readonly<{ availability: "available"; role: "scout"; status: "completed" | "partial"; selectedJobFound: false }>
  | Readonly<{ availability: "available"; role: "scout"; status: "completed" | "partial"; source: "greenhouse" | "lever" | "workday" | "smartrecruiters" | "personio" | "other"; evidenceKinds: readonly ("job" | "persona" | "resume" | "source")[] }>
  | Readonly<{ availability: "available"; role: "analyst"; status: "completed" | "partial"; selectedJobFound: false }>
  | Readonly<{ availability: "available"; role: "analyst"; status: "completed" | "partial"; score: number; evidenceKinds: readonly ("job" | "persona" | "resume" | "source")[] }>
  | Readonly<{ availability: "available"; role: "writer"; status: "completed" }>
  | Readonly<{ availability: "available"; role: "reviewer"; status: "completed"; reviewStatus: "passed" | "needs_revision" | "rejected" | "stale" }>
export type SelectedJobMemoryNode = Readonly<{
  role: "scout" | "analyst" | "writer" | "reviewer"
  status: SubagentTaskStatus
  readiness: "ready" | "waiting_for_dependencies" | "blocked_dependency" | "active" | "terminal"
  verification?: Readonly<{ status: "passed" | "failed" | "unverified"; criteria: readonly Readonly<{ status: "passed" | "failed" | "unverified"; reasonCode: TaskGraphVerificationReasonCode }>[] }>
  repairState: "none" | "pending" | "verified"
  result: SelectedJobMemoryResult
}>
export type SelectedJobMemoryRecord = Readonly<{
  jobId: string; sourceTurnId: string; sourceRootTaskId: string; graphRevision: number
  graphDigest: string; throughSequence: string; schemaVersion: typeof SELECTED_JOB_MEMORY_SCHEMA_VERSION
  nodes: readonly SelectedJobMemoryNode[]
}>

type Row = Record<string, unknown>
function row(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null ? value as Row : null
}
function exact(value: Row, keys: string): boolean {
  const own = Reflect.ownKeys(value)
  return own.every((key): key is string => typeof key === "string") && own.sort().join(",") === keys
}
function text(value: unknown): value is string { return typeof value === "string" && !!value.trim() && value.trim() === value && value.length <= 256 }
function evidence(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > EVIDENCE.size || value.some(item => typeof item !== "string" || !EVIDENCE.has(item)) || new Set(value).size !== value.length) return null
  return [...value as string[]].sort()
}
function count(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function digest(value: unknown): value is string { return typeof value === "string" && DIGEST.test(value) }
function artifactReference(value: unknown): boolean {
  const item = row(value)
  return !!item && exact(item, "artifactId,contentHash,sourceDigest,version") && text(item.artifactId)
    && Number.isSafeInteger(item.version) && Number(item.version) >= 1 && SHA256.test(String(item.contentHash)) && SHA256.test(String(item.sourceDigest))
}
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
function nodeKey(value: SelectedJobMemoryNode): string { return JSON.stringify(value) }
function recordKey(value: Pick<SelectedJobMemoryRecord, "jobId" | "sourceTurnId" | "sourceRootTaskId">): string { return [value.jobId, value.sourceTurnId, value.sourceRootTaskId].join("\0") }

function safeResult(value: unknown, role: string, jobId: string): SelectedJobMemoryResult | null {
  const item = row(value)
  if (!item || item.schemaVersion !== TASK_GRAPH_RESULT_PROJECTION_SCHEMA || item.trust !== "untrusted") return null
  if (item.availability === "unavailable" && exact(item, "availability,schemaVersion,trust")) return { availability: "unavailable" }
  if (item.availability !== "available" || item.role !== role) return null
  if (role === "scout" && exact(item, "availability,candidateCount,candidates,evidenceCount,role,schemaVersion,status,trust")
    && ["completed", "partial"].includes(String(item.status)) && count(item.candidateCount) && count(item.evidenceCount) && Array.isArray(item.candidates) && item.candidates.length <= 3) {
    const candidates = item.candidates.map(row)
    if (candidates.some(value => !value || !exact(value, "evidenceKinds,jobId,source") || !text(value.jobId) || typeof value.source !== "string" || !SOURCES.has(value.source) || !evidence(value.evidenceKinds))) return null
    const selected = candidates.find(value => value?.jobId === jobId)
    return selected ? { availability: "available", role, status: item.status as "completed" | "partial", source: selected.source as "greenhouse" | "lever" | "workday" | "smartrecruiters" | "personio" | "other", evidenceKinds: evidence(selected.evidenceKinds)! as readonly ("job" | "persona" | "resume" | "source")[] }
      : { availability: "available", role, status: item.status as "completed" | "partial", selectedJobFound: false }
  }
  if (role === "analyst" && exact(item, "availability,evidenceCount,findingCount,findings,role,schemaVersion,status,trust")
    && ["completed", "partial"].includes(String(item.status)) && count(item.findingCount) && count(item.evidenceCount) && Array.isArray(item.findings) && item.findings.length <= 3) {
    const findings = item.findings.map(row)
    if (findings.some(value => !value || !exact(value, "evidenceKinds,jobId,score") || !text(value.jobId)
      || typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0 || value.score > 10 || !evidence(value.evidenceKinds))) return null
    const selected = findings.find(value => value?.jobId === jobId)
    return selected ? { availability: "available", role, status: item.status as "completed" | "partial", score: selected.score as number, evidenceKinds: evidence(selected.evidenceKinds)! as readonly ("job" | "persona" | "resume" | "source")[] }
      : { availability: "available", role, status: item.status as "completed" | "partial", selectedJobFound: false }
  }
  if (role === "writer" && exact(item, "artifactRef,availability,role,schemaVersion,status,trust") && item.status === "completed" && artifactReference(item.artifactRef)) {
    return { availability: "available", role: "writer", status: "completed" }
  }
  if (role === "reviewer" && exact(item, "artifactRef,availability,reviewHash,reviewStatus,role,schemaVersion,status,trust")
    && item.status === "completed" && ["passed", "needs_revision", "rejected", "stale"].includes(String(item.reviewStatus)) && SHA256.test(String(item.reviewHash)) && artifactReference(item.artifactRef)) {
    return { availability: "available", role: "reviewer", status: "completed", reviewStatus: item.reviewStatus as "passed" | "needs_revision" | "rejected" | "stale" }
  }
  return null
}

function projectNode(value: unknown, jobId: string): SelectedJobMemoryNode | null {
  const item = row(value)
  const role = typeof item?.templateId === "string" ? ROLES.get(item.templateId) : undefined
  if (!item || !role || typeof item.status !== "string" || !STATUSES.has(item.status) || typeof item.readiness !== "string" || !READINESS.has(item.readiness)) return null
  let verification: SelectedJobMemoryNode["verification"]
  if (item.verificationCriterionIds !== undefined || item.verificationReport !== undefined) {
    const ids = parseTaskGraphVerificationCriterionIds(item.verificationCriterionIds)
    const report = ids && parseTaskGraphVerificationReport(item.verificationReport, ids)
    if (!report || !taskGraphVerificationReportMatchesStatus(report, item.status)) return null
    verification = { status: report.status, criteria: report.criteria.map(({ status, reasonCode }) => ({ status, reasonCode })) }
  }
  const repairOf = item.repairOf === undefined ? undefined : parseTaskGraphRepairOf(item.repairOf)
  if (item.repairOf !== undefined && !repairOf) return null
  const reportIds = parseTaskGraphVerificationCriterionIds(item.verificationCriterionIds)
  const report = reportIds && parseTaskGraphVerificationReport(item.verificationReport, reportIds)
  const receipt = item.repairReceipt === undefined ? undefined : parseTaskGraphRepairReceipt(item.repairReceipt, {
    repairOf, repairNodeKey: typeof item.key === "string" ? item.key : "", repairTaskId: typeof item.taskId === "string" ? item.taskId : "", report,
  })
  if (item.repairReceipt !== undefined && (!receipt || !repairOf)) return null
  const result = safeResult(item.resultProjection ?? { schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "unavailable" }, role, jobId)
  return result ? { role, status: item.status as SubagentTaskStatus, readiness: item.readiness as SelectedJobMemoryNode["readiness"],
    ...(verification ? { verification } : {}), repairState: repairOf ? receipt ? "verified" : "pending" : "none", result } : null
}
function digestFor(value: Omit<SelectedJobMemoryRecord, "graphDigest">): string { return sha256Hex(value) }

/** Projects only fixed TaskGraph status, parsed verification and selected-job typed results. */
export function projectSelectedJobMemory(input: {
  readonly jobId: string; readonly sourceTurnId: string; readonly sourceRootTaskId: string; readonly throughSequence: string
  readonly graph: TaskGraphCurrentState | Readonly<{ revision: number; nodes: readonly unknown[] }>
}): SelectedJobMemoryRecord | null {
  if (!text(input.jobId) || !text(input.sourceTurnId) || !text(input.sourceRootTaskId) || !/^(0|[1-9][0-9]*)$/.test(input.throughSequence)
    || !Number.isSafeInteger(input.graph.revision) || input.graph.revision < 1 || !Array.isArray(input.graph.nodes)
    || input.graph.nodes.length < 1 || input.graph.nodes.length > MAX_NODES) return null
  const projected = input.graph.nodes.map(node => projectNode(node, input.jobId))
  if (projected.some(node => !node)) return null
  const nodes = [...new Map((projected as SelectedJobMemoryNode[]).map(node => [nodeKey(node), node])).values()]
    .sort((left, right) => compare(left.role, right.role) || compare(nodeKey(left), nodeKey(right)))
  const identity = { schemaVersion: SELECTED_JOB_MEMORY_SCHEMA_VERSION, jobId: input.jobId, sourceTurnId: input.sourceTurnId,
    sourceRootTaskId: input.sourceRootTaskId, graphRevision: input.graph.revision, throughSequence: input.throughSequence, nodes }
  const memory: SelectedJobMemoryRecord = { ...identity, graphDigest: digestFor(identity) }
  return Buffer.byteLength(JSON.stringify(memory), "utf8") <= MAX_BYTES ? memory : null
}

function parseNode(value: unknown): SelectedJobMemoryNode | null {
  const item = row(value)
  if (!item || !(exact(item, "readiness,repairState,result,role,status") || exact(item, "readiness,repairState,result,role,status,verification"))
    || typeof item.role !== "string" || !["scout", "analyst", "writer", "reviewer"].includes(item.role)
    || typeof item.status !== "string" || !STATUSES.has(item.status) || typeof item.readiness !== "string" || !READINESS.has(item.readiness)
    || !["none", "pending", "verified"].includes(String(item.repairState))) return null
  const result = row(item.result)
  if (!result || typeof result.availability !== "string" || !["available", "unavailable"].includes(result.availability)) return null
  const resultKeys = Object.keys(result).sort().join(",")
  const role = item.role
  const safe = result.availability === "unavailable" && resultKeys === "availability"
    || result.availability === "available" && result.role === role && ((role === "scout" && ["availability,evidenceKinds,role,source,status", "availability,role,selectedJobFound,status"].includes(resultKeys)
      && (result.selectedJobFound === false || SOURCES.has(String(result.source)) && !!evidence(result.evidenceKinds)) && ["completed", "partial"].includes(String(result.status)))
      || (role === "analyst" && ["availability,evidenceKinds,role,score,status", "availability,role,selectedJobFound,status"].includes(resultKeys)
        && (result.selectedJobFound === false || typeof result.score === "number" && Number.isFinite(result.score) && result.score >= 0 && result.score <= 10 && !!evidence(result.evidenceKinds)) && ["completed", "partial"].includes(String(result.status)))
      || (role === "writer" && resultKeys === "availability,role,status" && result.status === "completed")
      || (role === "reviewer" && resultKeys === "availability,reviewStatus,role,status" && result.status === "completed" && ["passed", "needs_revision", "rejected", "stale"].includes(String(result.reviewStatus))))
  if (!safe || (item.verification !== undefined && !parseVerification(item.verification))) return null
  return { role: role as SelectedJobMemoryNode["role"], status: item.status as SubagentTaskStatus, readiness: item.readiness as SelectedJobMemoryNode["readiness"],
    ...(item.verification === undefined ? {} : { verification: parseVerification(item.verification)! }),
    repairState: item.repairState as SelectedJobMemoryNode["repairState"], result: result as SelectedJobMemoryNode["result"] }
}
function parseVerification(value: unknown): SelectedJobMemoryNode["verification"] | null {
  const item = row(value)
  if (!item || !exact(item, "criteria,status") || !["passed", "failed", "unverified"].includes(String(item.status)) || !Array.isArray(item.criteria) || item.criteria.length > 8) return null
  const criteria = item.criteria.map(row)
  if (criteria.some(criterion => !criterion || !exact(criterion, "reasonCode,status") || !["passed", "failed", "unverified"].includes(String(criterion.status))
    || typeof criterion.reasonCode !== "string" || !["criteria_met", "criterion_not_met", "reported_score_below_minimum", "contract_invalid", "projection_invalid", "role_mismatch", "canonical_evidence_missing", "canonical_evidence_invalid", "canonical_evidence_ambiguous", "result_invalid", "result_ambiguous", "result_evidence_unbound", "repair_target_unresolved"].includes(criterion.reasonCode))) return null
  const coherent = item.status === "passed" ? criteria.every(value => value?.status === "passed" && value.reasonCode === "criteria_met")
    : item.status === "failed" ? criteria.some(value => value?.status === "failed")
      && criteria.every(value => value?.status === "passed" && value.reasonCode === "criteria_met" || value?.status === "failed" && ["criterion_not_met", "reported_score_below_minimum"].includes(String(value.reasonCode)))
      : criteria.every(value => value?.status === "unverified" && !["criteria_met", "criterion_not_met", "reported_score_below_minimum", "repair_target_unresolved"].includes(String(value.reasonCode)))
  if (!criteria.length || !coherent) return null
  return { status: item.status as "passed" | "failed" | "unverified", criteria: criteria as unknown as NonNullable<SelectedJobMemoryNode["verification"]>["criteria"] }
}

export function parseSelectedJobMemories(value: unknown, missingIsEmpty = false): SelectedJobMemoryRecord[] | undefined {
  if (value === undefined && missingIsEmpty) return []
  if (!Array.isArray(value) || value.length > MAX_RECORDS) return undefined
  const records: SelectedJobMemoryRecord[] = []
  for (const entry of value) {
    const item = row(entry)
    if (!item || !exact(item, "graphDigest,graphRevision,jobId,nodes,schemaVersion,sourceRootTaskId,sourceTurnId,throughSequence")
      || item.schemaVersion !== SELECTED_JOB_MEMORY_SCHEMA_VERSION || !text(item.jobId) || !text(item.sourceTurnId) || !text(item.sourceRootTaskId)
      || !Number.isSafeInteger(item.graphRevision) || Number(item.graphRevision) < 1 || !digest(item.graphDigest)
      || typeof item.throughSequence !== "string" || !/^(0|[1-9][0-9]*)$/.test(item.throughSequence)
      || !Array.isArray(item.nodes) || item.nodes.length < 1 || item.nodes.length > MAX_NODES) return undefined
    const nodes = item.nodes.map(parseNode)
    if (nodes.some(node => !node)) return undefined
    const typedNodes = nodes as SelectedJobMemoryNode[]
    if (typedNodes.some((node, index) => index > 0 && compare(nodeKey(typedNodes[index - 1]!), nodeKey(node)) >= 0)) return undefined
    const identity = { schemaVersion: SELECTED_JOB_MEMORY_SCHEMA_VERSION, jobId: item.jobId, sourceTurnId: item.sourceTurnId,
      sourceRootTaskId: item.sourceRootTaskId, graphRevision: item.graphRevision as number, throughSequence: item.throughSequence, nodes: typedNodes }
    if (digestFor(identity) !== item.graphDigest) return undefined
    records.push({ ...identity, graphDigest: item.graphDigest })
  }
  if (records.some((value, index) => index > 0 && compare(recordKey(records[index - 1]!), recordKey(value)) >= 0)
    || Buffer.byteLength(JSON.stringify(records), "utf8") > MAX_BYTES) return undefined
  return records
}

export function mergeSelectedJobMemories(previous: readonly SelectedJobMemoryRecord[], current: readonly SelectedJobMemoryRecord[]): SelectedJobMemoryRecord[] {
  const merged = new Map(previous.map(value => [recordKey(value), value]))
  for (const value of current) merged.set(recordKey(value), value)
  const candidates = [...merged.values()].sort((left, right) => {
    const sequence = BigInt(right.throughSequence) - BigInt(left.throughSequence)
    return sequence < 0n ? -1 : sequence > 0n ? 1 : compare(recordKey(left), recordKey(right))
  })
  const selected: SelectedJobMemoryRecord[] = []
  for (const candidate of candidates) {
    if (selected.length >= MAX_RECORDS) break
    if (Buffer.byteLength(JSON.stringify([...selected, candidate]), "utf8") <= MAX_BYTES) selected.push(candidate)
  }
  return selected.sort((left, right) => compare(recordKey(left), recordKey(right)))
}

/** Add informational memory only after the selected-job snapshot filter was applied. */
export function injectSelectedJobMemory(input: {
  readonly snapshot: StepContextSnapshot; readonly records: readonly SelectedJobMemoryRecord[]; readonly jobId?: string
  readonly turnId: string; readonly rootTaskId?: string
}): StepContextSnapshot {
  if (!input.jobId || !input.rootTaskId) return input.snapshot
  const current = input.snapshot.toolObservations.find(item => item.id === "task-graph-current")
  const graph = row(current?.content)
  if (!graph || graph.kind !== "task_graph_current" || !Number.isSafeInteger(graph.revision) || !Array.isArray(graph.nodes)) return input.snapshot
  const records = parseSelectedJobMemories(input.records)
  if (!records) return input.snapshot
  const stored = records.find(value => value.jobId === input.jobId && value.sourceTurnId === input.turnId && value.sourceRootTaskId === input.rootTaskId)
  if (!stored) return input.snapshot
  const fresh = projectSelectedJobMemory({ jobId: input.jobId, sourceTurnId: input.turnId, sourceRootTaskId: input.rootTaskId,
    throughSequence: stored.throughSequence, graph: { revision: graph.revision as number, nodes: graph.nodes } })
  if (!fresh || fresh.graphRevision !== stored.graphRevision || fresh.graphDigest !== stored.graphDigest) return input.snapshot
  const observation = { id: "selected-job-memory", content: { kind: "selected_job_memory", informationalOnly: true,
    schemaVersion: SELECTED_JOB_MEMORY_SCHEMA_VERSION, graphRevision: stored.graphRevision, nodes: stored.nodes } }
  return { ...input.snapshot, toolObservations: [...input.snapshot.toolObservations.filter(item => item.id !== observation.id), observation] }
}
