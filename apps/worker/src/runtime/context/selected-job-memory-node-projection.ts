import {
  parseTaskGraphRepairOf, parseTaskGraphRepairReceipt, parseTaskGraphVerificationCriterionIds,
  parseTaskGraphVerificationReport, taskGraphVerificationReportMatchesStatus, TASK_GRAPH_RESULT_PROJECTION_SCHEMA,
  type TaskGraphCurrentState,
} from "../subagents/task-graph-command-port.js"
import type { TaskGraphVerificationReasonCode } from "../planning/task-graph-verification.js"
import type { SubagentTaskStatus } from "../subagents/types.js"
import type { SelectedJobMemoryNode, SelectedJobMemoryResult } from "./selected-job-memory.js"

const MAX_NODES = 8
const STATUSES = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"])
const READINESS = new Set(["ready", "waiting_for_dependencies", "blocked_dependency", "active", "terminal"])
const ROLES = new Map<string, SelectedJobMemoryNode["role"]>([["scout", "scout"], ["analyst", "analyst"], ["cover_letter_writer", "writer"], ["cover_letter_reviewer", "reviewer"]])
const SOURCES = new Set(["greenhouse", "lever", "workday", "smartrecruiters", "personio", "other"])
const EVIDENCE = new Set(["job", "persona", "resume", "source"])
const VERIFICATION_REASONS = new Set(["criteria_met", "criterion_not_met", "reported_score_below_minimum", "contract_invalid", "projection_invalid", "role_mismatch", "canonical_evidence_missing", "canonical_evidence_invalid", "canonical_evidence_ambiguous", "result_invalid", "result_ambiguous", "result_evidence_unbound", "repair_target_unresolved"])

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
function dense(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length <= MAX_NODES && Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean)
}
function evidence(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > EVIDENCE.size || value.some(item => typeof item !== "string" || !EVIDENCE.has(item)) || new Set(value).size !== value.length) return null
  return [...value as string[]].sort()
}
function count(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function artifactReference(value: unknown): boolean {
  const item = row(value)
  return !!item && exact(item, "artifactId,contentHash,sourceDigest,version") && text(item.artifactId)
    && Number.isSafeInteger(item.version) && Number(item.version) >= 1
    && /^sha256:[a-f0-9]{64}$/.test(String(item.contentHash)) && /^sha256:[a-f0-9]{64}$/.test(String(item.sourceDigest))
}
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
function nodeKey(value: SelectedJobMemoryNode): string { return JSON.stringify(value) }

function safeResult(value: unknown, role: string, jobId: string): SelectedJobMemoryResult | null {
  const item = row(value)
  if (!item || item.schemaVersion !== TASK_GRAPH_RESULT_PROJECTION_SCHEMA || item.trust !== "untrusted") return null
  if (item.availability === "unavailable" && exact(item, "availability,schemaVersion,trust")) return { availability: "unavailable" }
  if (item.availability !== "available" || item.role !== role) return null
  if (role === "scout" && exact(item, "availability,candidateCount,candidates,evidenceCount,role,schemaVersion,status,trust")
    && ["completed", "partial"].includes(String(item.status)) && count(item.candidateCount) && count(item.evidenceCount)
    && dense(item.candidates) && item.candidates.length <= 3) {
    const candidates = item.candidates.map(row)
    if (candidates.some(value => !value || !exact(value, "evidenceKinds,jobId,source") || !text(value.jobId)
      || typeof value.source !== "string" || !SOURCES.has(value.source) || !evidence(value.evidenceKinds))) return null
    const selected = candidates.find(value => value?.jobId === jobId)
    return selected ? { availability: "available", role, status: item.status as "completed" | "partial", source: selected.source as "greenhouse" | "lever" | "workday" | "smartrecruiters" | "personio" | "other", evidenceKinds: evidence(selected.evidenceKinds)! as readonly ("job" | "persona" | "resume" | "source")[] }
      : { availability: "available", role, status: item.status as "completed" | "partial", selectedJobFound: false }
  }
  if (role === "analyst" && exact(item, "availability,evidenceCount,findingCount,findings,role,schemaVersion,status,trust")
    && ["completed", "partial"].includes(String(item.status)) && count(item.findingCount) && count(item.evidenceCount)
    && dense(item.findings) && item.findings.length <= 3) {
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
    && item.status === "completed" && ["passed", "needs_revision", "rejected", "stale"].includes(String(item.reviewStatus))
    && /^sha256:[a-f0-9]{64}$/.test(String(item.reviewHash)) && artifactReference(item.artifactRef)) {
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

function parseVerification(value: unknown): SelectedJobMemoryNode["verification"] | null {
  const item = row(value)
  if (!item || !exact(item, "criteria,status") || !["passed", "failed", "unverified"].includes(String(item.status))
    || !dense(item.criteria) || item.criteria.length > 8) return null
  const criteria = item.criteria.map(row)
  if (criteria.some(criterion => !criterion || !exact(criterion, "reasonCode,status")
    || !["passed", "failed", "unverified"].includes(String(criterion.status))
    || typeof criterion.reasonCode !== "string" || !VERIFICATION_REASONS.has(criterion.reasonCode))) return null
  const coherent = item.status === "passed" ? criteria.every(value => value?.status === "passed" && value.reasonCode === "criteria_met")
    : item.status === "failed" ? criteria.some(value => value?.status === "failed")
      && criteria.every(value => value?.status === "passed" && value.reasonCode === "criteria_met" || value?.status === "failed" && ["criterion_not_met", "reported_score_below_minimum"].includes(String(value.reasonCode)))
      : criteria.every(value => value?.status === "unverified" && !["criteria_met", "criterion_not_met", "reported_score_below_minimum", "repair_target_unresolved"].includes(String(value.reasonCode)))
  if (!criteria.length || !coherent) return null
  return { status: item.status as "passed" | "failed" | "unverified", criteria: criteria.map(value => ({ status: value!.status as "passed" | "failed" | "unverified", reasonCode: value!.reasonCode as TaskGraphVerificationReasonCode })) }
}

function parseStoredResult(value: unknown, role: string): SelectedJobMemoryResult | null {
  const item = row(value)
  if (!item) return null
  if (item.availability === "unavailable" && exact(item, "availability")) return { availability: "unavailable" }
  if (item.availability !== "available" || item.role !== role) return null
  const taskStatus = ["completed", "partial"].includes(String(item.status))
  if (role === "scout" && taskStatus) {
    if (exact(item, "availability,role,selectedJobFound,status") && item.selectedJobFound === false) return { availability: "available", role: "scout", status: item.status as "completed" | "partial", selectedJobFound: false }
    const evidenceKinds = evidence(item.evidenceKinds)
    if (exact(item, "availability,evidenceKinds,role,source,status") && typeof item.source === "string" && SOURCES.has(item.source) && evidenceKinds)
      return { availability: "available", role: "scout", status: item.status as "completed" | "partial", source: item.source as "greenhouse" | "lever" | "workday" | "smartrecruiters" | "personio" | "other", evidenceKinds: evidenceKinds as readonly ("job" | "persona" | "resume" | "source")[] }
  }
  if (role === "analyst" && taskStatus) {
    if (exact(item, "availability,role,selectedJobFound,status") && item.selectedJobFound === false) return { availability: "available", role: "analyst", status: item.status as "completed" | "partial", selectedJobFound: false }
    const evidenceKinds = evidence(item.evidenceKinds)
    if (exact(item, "availability,evidenceKinds,role,score,status") && typeof item.score === "number" && Number.isFinite(item.score) && item.score >= 0 && item.score <= 10 && evidenceKinds)
      return { availability: "available", role: "analyst", status: item.status as "completed" | "partial", score: item.score, evidenceKinds: evidenceKinds as readonly ("job" | "persona" | "resume" | "source")[] }
  }
  if (role === "writer" && exact(item, "availability,role,status") && item.status === "completed") return { availability: "available", role: "writer", status: "completed" }
  if (role === "reviewer" && exact(item, "availability,reviewStatus,role,status") && item.status === "completed"
    && ["passed", "needs_revision", "rejected", "stale"].includes(String(item.reviewStatus))) return { availability: "available", role: "reviewer", status: "completed", reviewStatus: item.reviewStatus as "passed" | "needs_revision" | "rejected" | "stale" }
  return null
}

function parseNode(value: unknown): SelectedJobMemoryNode | null {
  const item = row(value)
  if (!item || !(exact(item, "readiness,repairState,result,role,status") || exact(item, "readiness,repairState,result,role,status,verification"))
    || typeof item.role !== "string" || !["scout", "analyst", "writer", "reviewer"].includes(item.role)
    || typeof item.status !== "string" || !STATUSES.has(item.status) || typeof item.readiness !== "string" || !READINESS.has(item.readiness)
    || !["none", "pending", "verified"].includes(String(item.repairState))) return null
  const result = parseStoredResult(item.result, item.role)
  const verification = item.verification === undefined ? undefined : parseVerification(item.verification)
  if (!result || (item.verification !== undefined && !verification)) return null
  return { role: item.role as SelectedJobMemoryNode["role"], status: item.status as SubagentTaskStatus,
    readiness: item.readiness as SelectedJobMemoryNode["readiness"], ...(verification ? { verification } : {}),
    repairState: item.repairState as SelectedJobMemoryNode["repairState"], result }
}

/** Strictly parses the bounded canonical typed-node array without trusting its source metadata. */
export function parseSelectedJobMemoryNodes(value: unknown): readonly SelectedJobMemoryNode[] | null {
  if (!dense(value) || value.length < 1) return null
  const nodes = value.map(parseNode)
  if (nodes.some(node => !node)) return null
  const typed = nodes as SelectedJobMemoryNode[]
  if (typed.some((node, index) => index > 0 && compare(nodeKey(typed[index - 1]!), nodeKey(node)) >= 0)) return null
  return typed
}

/** Extracts the exact bounded typed-node projection shared by compacted and direct history. */
export function projectSelectedJobMemoryNodes(input: {
  readonly jobId: string
  readonly graph: TaskGraphCurrentState | Readonly<{ revision: number; nodes: readonly unknown[] }>
}): readonly SelectedJobMemoryNode[] | null {
  if (!text(input.jobId) || !Number.isSafeInteger(input.graph.revision) || input.graph.revision < 1
    || !dense(input.graph.nodes) || input.graph.nodes.length < 1) return null
  const projected = input.graph.nodes.map(node => projectNode(node, input.jobId))
  if (projected.some(node => !node)) return null
  return [...new Map((projected as SelectedJobMemoryNode[]).map(node => [nodeKey(node), node])).values()]
    .sort((left, right) => compare(left.role, right.role) || compare(nodeKey(left), nodeKey(right)))
}
