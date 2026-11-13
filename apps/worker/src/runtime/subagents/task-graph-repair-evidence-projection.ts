import {
  parseTaskGraphVerificationEvidenceProjection,
  TASK_GRAPH_VERIFICATION_EVIDENCE_V2_SCHEMA_VERSION,
  TASK_GRAPH_VERIFICATION_LIMITS,
  type TaskGraphVerificationCandidateProjectionV2,
} from "../planning/task-graph-verification-cross-node.js"
import type pg from "pg"
import { canonicalTaskGraphJson, type StoredTaskGraphNode, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"
import { isValidScoutTaskEnvelope } from "./task-graph-pg-completed-dependency-verification.js"
import { reverifyFailedTaskGraphNodeEvidence, taskGraphResultDigest, verifyCompletedTaskGraphNodeEvidence } from "./task-graph-pg-verification.js"
import { parseTaskGraphRepairReceipt, parseTaskGraphVerificationReport, taskGraphVerificationReportMatchesStatus, type TaskGraphVerificationReport } from "./task-graph-command-port.js"
import { ROLE_RESULT_SCHEMA, validateRoleResult, type AnalystResult, type ScoutResult, type StructuredRole, type StructuredRoleResult } from "./role-results.js"

export type ReverifiedScoutEvidencePiece = Readonly<{ projection: unknown; structuredResult: unknown }>
export type RepairTaskEvidenceRow = Readonly<Record<string, unknown>>
type CandidateState = { source: string; evidenceIds: Set<string>; location: string | null; status: "verified" | "missing" | "conflicting" }
type Queryable = Pick<pg.PoolClient, "query">
const BASE = "finalItemId,finalText,status,stepCount,structuredResult,toolCallCount"

/** Rebuilds a failed partial only from the same persisted owner/attempt receipt chain. */
export async function reverifyFailedScoutLocationPartial(input: Readonly<{
  client: Queryable; scope: GraphIdentityScope; snapshot: TaskGraphSnapshot
  node: StoredTaskGraphNode; row: RepairTaskEvidenceRow; report: TaskGraphVerificationReport; structuredResult: unknown
}>): Promise<ReverifiedScoutEvidencePiece | undefined> {
  const { client, scope, snapshot, node, row, report, structuredResult } = input
  if (!validLocationScoutNode(node) || row.status !== "failed" || !failedReasonMatches(row.failureReason, report)
    || !validAttempt(row.attemptCount) || !isValidScoutTaskEnvelope(node, row.taskType, row.expectedOutputSchema, row.allowedActions)
    || !sameEnvelopeOutput(row.result, structuredResult, report)) return undefined
  const verified = await reverifyFailedTaskGraphNodeEvidence(client, {
    scope: { ...scope, taskId: node.taskId, attemptCount: Number(row.attemptCount) }, snapshot, node, structuredResult,
    includeObservedLocation: true,
  })
  if ((verified.report.status !== "failed" && verified.report.status !== "unverified")
    || !sameReport(verified.report, report) || !verified.report.evidenceDigest || !verified.report.resultDigest
    || !sameRoleResult(verified.structuredResult, structuredResult)
    || verified.report.resultDigest !== taskGraphResultDigest(verified.structuredResult) || !validLocationProjection(verified.projection)) return undefined
  return { projection: verified.projection, structuredResult: verified.structuredResult }
}

/** Rebuilds a completed repair from its current attempt and exact persisted receipt. */
export async function reverifyCompletedScoutLocationRepair(input: Readonly<{
  client: Queryable; scope: GraphIdentityScope; snapshot: TaskGraphSnapshot
  node: StoredTaskGraphNode; row: RepairTaskEvidenceRow; report: TaskGraphVerificationReport; structuredResult: unknown
}>): Promise<ReverifiedScoutEvidencePiece | undefined> {
  const { client, scope, snapshot, node, row, report, structuredResult } = input
  if (!validLocationScoutNode(node) || row.status !== "completed" || row.failureReason !== null
    || !validAttempt(row.attemptCount) || !isValidScoutTaskEnvelope(node, row.taskType, row.expectedOutputSchema, row.allowedActions)
    || !sameEnvelopeOutput(row.result, structuredResult, report)) return undefined
  const verified = await verifyCompletedTaskGraphNodeEvidence(client, {
    scope: { ...scope, taskId: node.taskId, attemptCount: Number(row.attemptCount) }, snapshot, node, structuredResult,
    includeObservedLocation: true,
  })
  if (!verified.verified || verified.report.status !== "passed" || !sameReport(verified.report, report)
    || !verified.report.evidenceDigest || !verified.report.resultDigest
    || !sameRoleResult(verified.structuredResult, structuredResult)
    || verified.report.resultDigest !== taskGraphResultDigest(verified.structuredResult) || !validLocationProjection(verified.projection)) return undefined
  return { projection: verified.projection, structuredResult: verified.structuredResult }
}

function validLocationScoutNode(node: StoredTaskGraphNode): boolean {
  return node.templateId === "scout" && node.verificationDisposition === "typed" && node.verification?.role === "scout"
    && node.verification.criteria.some(item => item.check.kind === "candidate_location_in")
}
function validAttempt(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 1 }
function failedReasonMatches(value: unknown, report: TaskGraphVerificationReport): boolean {
  return (report.status === "failed" || report.status === "unverified") && value === `task_graph_verification_${report.status}`
}
function sameReport(left: TaskGraphVerificationReport, right: TaskGraphVerificationReport): boolean {
  return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right)
}
function sameRoleResult(left: unknown, right: unknown): boolean {
  try { return canonicalTaskGraphJson(validateRoleResult(left, "scout")) === canonicalTaskGraphJson(validateRoleResult(right, "scout")) } catch { return false }
}
function sameEnvelopeOutput(envelopeValue: unknown, result: unknown, report: TaskGraphVerificationReport): boolean {
  const envelope = object(envelopeValue)
  return !!envelope && envelope.status === "completed"
    && Object.hasOwn(envelope, "structuredResult") && Object.hasOwn(envelope, "taskGraphVerificationReport")
    && canonicalTaskGraphJson(envelope.structuredResult) === canonicalTaskGraphJson(result)
    && canonicalTaskGraphJson(envelope.taskGraphVerificationReport) === canonicalTaskGraphJson(report)
}
function validLocationProjection(value: unknown): boolean {
  const parsed = parseTaskGraphVerificationEvidenceProjection(value)
  return parsed.ok && parsed.value.schemaVersion === TASK_GRAPH_VERIFICATION_EVIDENCE_V2_SCHEMA_VERSION
    && parsed.value.role === "scout" && parsed.value.emptyDiscoveryDigest === undefined
}
function object(value: unknown): Record<string, unknown> | undefined {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return undefined } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
}

export function canonicalResultEvidenceIds(value: ScoutResult | AnalystResult): string[] {
  for (const item of value.evidence) if (item.kind === "source" || item.id !== `read:${item.kind}:${item.ref}`) {
    throw new Error("task_graph_dependency_repair_evidence_unbound")
  }
  return value.evidence.map(item => item.id)
}

export function parseFailedOriginalResult(value: Record<string, unknown> | null, node: StoredTaskGraphNode, report: TaskGraphVerificationReport, role: StructuredRole): StructuredRoleResult | undefined {
  if (!value) return undefined
  const reportOnly = "taskGraphVerificationReport", reportWithNullWorkerResult = "taskGraphVerificationReport,workerResult"
  const keys = Object.keys(value).sort().join(",")
  if (keys === reportOnly || keys === reportWithNullWorkerResult) {
    const storedReport = parseTaskGraphVerificationReport(value.taskGraphVerificationReport, node.verification?.criteria.map(item => item.id) ?? [])
    if (!exactPlainKeys(value, keys) || (keys === reportWithNullWorkerResult && value.workerResult !== null)
      || node.verificationDisposition !== "typed" || !node.verification || node.verification.role !== role
      || !storedReport || storedReport.status !== "unverified" || storedReport.reasonCode !== "result_invalid"
      || storedReport.evidenceDigest !== null || storedReport.resultDigest !== null
      || !taskGraphVerificationReportMatchesStatus(report, "failed")
      || !taskGraphVerificationReportMatchesStatus(storedReport, "failed")) {
      throw new Error("task_graph_dependency_repair_original_invalid")
    }
    return undefined
  }
  const without = ["finalItemId", "finalText", "status", "stepCount", "taskGraphVerificationReport", "toolCallCount"].sort().join(",")
  const withResult = [...BASE.split(","), "taskGraphVerificationReport"].sort().join(",")
  if ((keys !== without && keys !== withResult) || value.status !== "completed" || !taskGraphVerificationReportMatchesStatus(report, "failed")
    || !parseTaskGraphVerificationReport(value.taskGraphVerificationReport, node.verification?.criteria.map(item => item.id) ?? [])) {
    throw new Error("task_graph_dependency_repair_original_invalid")
  }
  if (!Object.hasOwn(value, "structuredResult")) { if (report.resultDigest !== null) throw new Error("task_graph_dependency_repair_original_digest_invalid"); return undefined }
  const result = validateRoleResult(value.structuredResult, role)
  if (report.resultDigest !== taskGraphResultDigest(result)) throw new Error("task_graph_dependency_repair_original_digest_invalid")
  return result
}

export function parseCompletedRepairResult(value: Record<string, unknown> | null, node: StoredTaskGraphNode, report: TaskGraphVerificationReport | undefined): unknown {
  if (!value || !node.verification) throw new Error("task_graph_dependency_repair_result_invalid")
  const hasReceipt = value.taskGraphRepairReceipt !== undefined
  const expected = [...BASE.split(","), "taskGraphVerificationReport", ...(hasReceipt ? ["taskGraphRepairReceipt"] : [])].sort().join(",")
  const normalized = validateRoleResult(value.structuredResult, node.verification.role)
  if (Object.keys(value).sort().join(",") !== expected || !report || !taskGraphVerificationReportMatchesStatus(report, "completed")
    || report.resultDigest !== taskGraphResultDigest(normalized)
    || !parseTaskGraphRepairReceipt(value.taskGraphRepairReceipt, { repairOf: node.repairOf, repairNodeKey: node.key, repairTaskId: node.taskId, report })) {
    throw new Error("task_graph_dependency_repair_result_invalid")
  }
  return value.structuredResult
}

export function mergeRepairedRoleResults(pieces: readonly { result: StructuredRoleResult; criterionIds: readonly string[] }[], target: StoredTaskGraphNode): StructuredRoleResult {
  const values = pieces.map(piece => piece.result), first = values[0]!
  if (first.role === "scout") {
    const evidence = mergeEvidence(values), items = new Map<string, ScoutResult["candidates"][number]>()
    for (const value of values) {
      if (value.role !== "scout" || value.status !== "completed") throw new Error("task_graph_dependency_repair_role_conflict")
      for (const item of value.candidates) {
        const prior = items.get(item.jobId)
        if (prior && (prior.source !== item.source || prior.url !== item.url)) throw new Error("task_graph_dependency_repair_item_conflict")
        items.set(item.jobId, { ...item, evidenceIds: [...new Set([...(prior?.evidenceIds ?? []), ...item.evidenceIds])] })
      }
    }
    return validateRoleResult({ schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed", candidates: [...items.values()].sort((a, b) => a.jobId.localeCompare(b.jobId)), evidence, summary: "Verified repair results." }, "scout")
  }
  if (first.role === "analyst") {
    const evidence = mergeEvidence(values), items = new Map<string, AnalystResult["findings"][number]>(), repairedScores = new Set<string>()
    for (const [index, value] of values.entries()) {
      if (value.role !== "analyst" || value.status !== "completed") throw new Error("task_graph_dependency_repair_role_conflict")
      const replaceScore = pieces[index]!.criterionIds.some(id => target.verification?.criteria.some(item => item.id === id && item.check.kind === "reported_score_gte"))
      for (const item of value.findings) {
        const prior = items.get(item.jobId)
        if (prior && prior.score !== item.score && (!replaceScore || repairedScores.has(item.jobId))) throw new Error("task_graph_dependency_repair_item_conflict")
        items.set(item.jobId, { ...(prior && !replaceScore ? prior : item), evidenceIds: [...new Set([...(prior?.evidenceIds ?? []), ...item.evidenceIds])] })
        if (replaceScore) repairedScores.add(item.jobId)
      }
    }
    return validateRoleResult({ schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed", findings: [...items.values()].sort((a, b) => a.jobId.localeCompare(b.jobId)), evidence, summary: "Verified repair results." }, "analyst")
  }
  throw new Error("task_graph_dependency_repair_role_unsupported")
}

function mergeEvidence(values: readonly StructuredRoleResult[]) {
  const evidence = new Map<string, ScoutResult["evidence"][number]>()
  for (const value of values) {
    if ((value.role !== "scout" && value.role !== "analyst") || value.status !== "completed") throw new Error("task_graph_dependency_repair_partial")
    for (const item of value.evidence) {
      const prior = evidence.get(item.id)
      if (prior && (prior.kind !== item.kind || prior.ref !== item.ref || prior.source !== item.source)) throw new Error("task_graph_dependency_repair_evidence_conflict")
      evidence.set(item.id, item)
    }
  }
  return [...evidence.values()]
}

function exactPlainKeys(value: Record<string, unknown>, expected: string): boolean {
  try {
    const keys = Reflect.ownKeys(value)
    return Object.getPrototypeOf(value) === Object.prototype && keys.every(key => typeof key === "string")
      && keys.sort().join(",") === expected && Object.values(Object.getOwnPropertyDescriptors(value))
        .every(descriptor => descriptor.enumerable === true && Object.hasOwn(descriptor, "value"))
  } catch { return false }
}

/** Merges only projections and bound results returned by exact-attempt PG re-verification. */
export function mergeReverifiedScoutLocationEvidence(
  pieces: readonly ReverifiedScoutEvidencePiece[],
): Readonly<{ schemaVersion: typeof TASK_GRAPH_VERIFICATION_EVIDENCE_V2_SCHEMA_VERSION; role: "scout"; candidates: readonly TaskGraphVerificationCandidateProjectionV2[]; evidenceIds: readonly string[] }> | undefined {
  if (pieces.length === 0) return undefined
  const candidates = new Map<string, CandidateState>(), evidenceIds = new Set<string>()
  for (const piece of pieces) {
    const parsed = parseTaskGraphVerificationEvidenceProjection(piece.projection)
    if (!parsed.ok || parsed.value.schemaVersion !== TASK_GRAPH_VERIFICATION_EVIDENCE_V2_SCHEMA_VERSION
      || parsed.value.role !== "scout" || parsed.value.emptyDiscoveryDigest !== undefined) return undefined
    let result: ScoutResult
    try { result = validateRoleResult(piece.structuredResult, "scout") as ScoutResult } catch { return undefined }
    if (result.status !== "completed" || result.candidates.length !== parsed.value.items.length) return undefined
    const resultById = new Map(result.candidates.map(candidate => [candidate.jobId, candidate] as const))
    if (resultById.size !== parsed.value.items.length) return undefined
    for (const item of parsed.value.items) {
      const bound = resultById.get(item.jobId)
      if (!bound || !sameStrings(bound.evidenceIds, item.evidenceIds) || !item.locationEvidenceStatus) return undefined
      const prior = candidates.get(item.jobId)
      if (!prior) {
        candidates.set(item.jobId, {
          source: bound.source, evidenceIds: new Set(item.evidenceIds),
          location: item.observedLocation ?? null, status: item.locationEvidenceStatus,
        })
        continue
      }
      for (const id of item.evidenceIds) prior.evidenceIds.add(id)
      if (prior.source !== bound.source || prior.status !== item.locationEvidenceStatus || prior.location !== (item.observedLocation ?? null)) {
        prior.source = ""
        prior.location = null
        prior.status = "conflicting"
      }
    }
    for (const id of parsed.value.evidenceIds) evidenceIds.add(id)
  }
  if (candidates.size === 0 || candidates.size > TASK_GRAPH_VERIFICATION_LIMITS.maxItems
    || evidenceIds.size > TASK_GRAPH_VERIFICATION_LIMITS.maxItems) return undefined
  return {
    schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_V2_SCHEMA_VERSION,
    role: "scout",
    candidates: [...candidates.entries()].sort(([left], [right]) => compare(left, right)).map(([jobId, state]) => ({
      jobId, evidenceIds: [...state.evidenceIds].sort(compare), observedLocation: state.status === "verified" ? state.location : null,
      locationEvidenceStatus: state.status,
    })),
    evidenceIds: [...evidenceIds].sort(compare),
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
