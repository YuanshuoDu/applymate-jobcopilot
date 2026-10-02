import type { ObservedEvidenceIndex } from "./child-evidence.js"
import { validateRoleResult, type AnalystResult, type RoleEvidence, type ScoutResult } from "./role-results.js"

export const DISCOVERY_SHORTLIST_SCHEMA_VERSION = 1 as const
export const DISCOVERY_SHORTLIST_MAX_ITEMS = 3

export type DiscoveryShortlistFailureCode =
  | "owner_scope_missing"
  | "observed_evidence_invalid"
  | "invalid_scout_result"
  | "invalid_analyst_result"
  | "scout_task_missing"
  | "analyst_task_missing"
  | "scout_task_failed"
  | "analyst_task_failed"
  | "scout_task_incomplete"
  | "analyst_task_incomplete"
  | "scout_result_partial"
  | "analyst_result_partial"
  | "evidence_conflict"
  | "evidence_unverified"
  | "invalid_job_id"
  | "duplicate_scout_job"
  | "duplicate_analyst_finding"
  | "conflicting_analyst_score"
  | "no_common_candidates"
  | "discovery_runtime_unavailable"
  | "discovery_runtime_failed"

export type DiscoveryShortlistItem = Readonly<{
  jobId: string
  score: number
  evidenceIds: readonly string[]
}>

export type DiscoveryShortlistResult = Readonly<{
  schemaVersion: typeof DISCOVERY_SHORTLIST_SCHEMA_VERSION
  status: "completed" | "partial" | "failed"
  items: readonly DiscoveryShortlistItem[]
  failures: readonly DiscoveryShortlistFailureCode[]
}>

export type DiscoveryShortlistInput = Readonly<{
  /** Server-owned user scope paired with the persisted results and read index. */
  ownerUserId: string
  scoutResult: unknown
  analystResult: unknown
  /** Must contain only observations collected under ownerUserId's runtime scope. */
  observedEvidence: ObservedEvidenceIndex
}>

const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/
const failureOrder: readonly DiscoveryShortlistFailureCode[] = [
  "owner_scope_missing", "observed_evidence_invalid", "invalid_scout_result", "invalid_analyst_result",
  "scout_task_missing", "analyst_task_missing", "scout_task_failed", "analyst_task_failed", "scout_task_incomplete", "analyst_task_incomplete",
  "scout_result_partial", "analyst_result_partial", "evidence_conflict", "evidence_unverified",
  "invalid_job_id", "duplicate_scout_job", "duplicate_analyst_finding", "conflicting_analyst_score", "no_common_candidates",
  "discovery_runtime_unavailable", "discovery_runtime_failed",
]

/** Builds a deterministic, evidence-bound shortlist from owner-scoped persisted role results. */
export function buildDiscoveryShortlist(input: DiscoveryShortlistInput): DiscoveryShortlistResult {
  const failures = new Set<DiscoveryShortlistFailureCode>()
  const finish = (items: readonly DiscoveryShortlistItem[]): DiscoveryShortlistResult => {
    const orderedFailures = failureOrder.filter(code => failures.has(code))
    return {
      schemaVersion: DISCOVERY_SHORTLIST_SCHEMA_VERSION,
      status: items.length === 0 ? "failed" : orderedFailures.length > 0 ? "partial" : "completed",
      items: items.slice(0, DISCOVERY_SHORTLIST_MAX_ITEMS),
      failures: orderedFailures.length > 0 ? orderedFailures : items.length === 0 ? ["no_common_candidates"] : [],
    }
  }

  try {
    if (!input || typeof input.ownerUserId !== "string" || input.ownerUserId.trim().length === 0 || input.ownerUserId.length > 256) {
      failures.add("owner_scope_missing")
      return finish([])
    }
    if (!validObservedIndex(input.observedEvidence)) {
      failures.add("observed_evidence_invalid")
      return finish([])
    }

    const scout = parseResult(input.scoutResult, "scout", failures)
    const analyst = parseResult(input.analystResult, "analyst", failures)
    if (!scout || !analyst) return finish([])
    if (scout.status === "partial") failures.add("scout_result_partial")
    if (analyst.status === "partial") failures.add("analyst_result_partial")

    const scoutEvidenceValid = verifyEvidence(scout, input.observedEvidence, failures)
    const analystEvidenceValid = verifyEvidence(analyst, input.observedEvidence, failures)
    if (!scoutEvidenceValid || !analystEvidenceValid) return finish([])

    const scoutJobs = collectScoutJobs(scout, input.observedEvidence, failures)
    const analystJobs = collectAnalystJobs(analyst, input.observedEvidence, failures)
    const items: DiscoveryShortlistItem[] = []
    for (const [jobId, score] of analystJobs.scores) {
      if (analystJobs.conflicts.has(jobId) || !scoutJobs.has(jobId)) continue
      const evidence = observedJobEvidence(scout, jobId, input.observedEvidence)
      if (!evidence) {
        failures.add("evidence_unverified")
        continue
      }
      items.push({ jobId, score, evidenceIds: [evidence.id] })
    }
    items.sort((left, right) => right.score - left.score || compareText(left.jobId, right.jobId))
    if (items.length === 0 && scoutJobs.size > 0 && analystJobs.scores.size > 0) failures.add("no_common_candidates")
    return finish(items.slice(0, DISCOVERY_SHORTLIST_MAX_ITEMS))
  } catch {
    failures.add("observed_evidence_invalid")
    return finish([])
  }
}

function parseResult(value: unknown, role: "scout", failures: Set<DiscoveryShortlistFailureCode>): ScoutResult | undefined
function parseResult(value: unknown, role: "analyst", failures: Set<DiscoveryShortlistFailureCode>): AnalystResult | undefined
function parseResult(value: unknown, role: "scout" | "analyst", failures: Set<DiscoveryShortlistFailureCode>): ScoutResult | AnalystResult | undefined {
  try {
    const result = validateRoleResult(value, role)
    return result.role === role ? result : undefined
  } catch {
    failures.add(role === "scout" ? "invalid_scout_result" : "invalid_analyst_result")
    return undefined
  }
}

function validObservedIndex(value: unknown): value is ObservedEvidenceIndex {
  if (!value || typeof value !== "object") return false
  const index = value as ObservedEvidenceIndex
  return index.entries instanceof Map && index.conflicts instanceof Set
}

function verifyEvidence(result: ScoutResult | AnalystResult, index: ObservedEvidenceIndex, failures: Set<DiscoveryShortlistFailureCode>): boolean {
  let valid = true
  for (const evidence of result.evidence) {
    const key = evidenceKey(evidence.kind, evidence.ref)
    if (index.conflicts.has(key)) {
      failures.add("evidence_conflict")
      valid = false
      continue
    }
    const observed = index.entries.get(key)
    if (!observed || !sameEvidence(evidence, observed)) {
      failures.add("evidence_unverified")
      valid = false
    }
  }
  return valid
}

function collectScoutJobs(result: ScoutResult, index: ObservedEvidenceIndex, failures: Set<DiscoveryShortlistFailureCode>): Set<string> {
  const jobs = new Set<string>()
  for (const candidate of result.candidates) {
    if (!SAFE_JOB_ID.test(candidate.jobId)) { failures.add("invalid_job_id"); continue }
    if (!observedJobEvidence(result, candidate.jobId, index)) { failures.add("evidence_unverified"); continue }
    if (jobs.has(candidate.jobId)) failures.add("duplicate_scout_job")
    jobs.add(candidate.jobId)
  }
  return jobs
}

function collectAnalystJobs(result: AnalystResult, index: ObservedEvidenceIndex, failures: Set<DiscoveryShortlistFailureCode>): { scores: Map<string, number>; conflicts: Set<string> } {
  const scores = new Map<string, number>()
  const conflicts = new Set<string>()
  for (const finding of result.findings) {
    if (!SAFE_JOB_ID.test(finding.jobId)) { failures.add("invalid_job_id"); continue }
    if (!observedJobEvidence(result, finding.jobId, index)) { failures.add("evidence_unverified"); continue }
    if (scores.has(finding.jobId)) {
      failures.add("duplicate_analyst_finding")
      if (scores.get(finding.jobId) !== finding.score) {
        failures.add("conflicting_analyst_score")
        conflicts.add(finding.jobId)
      }
    } else scores.set(finding.jobId, finding.score)
  }
  return { scores, conflicts }
}

function observedJobEvidence(result: ScoutResult | AnalystResult, jobId: string, index: ObservedEvidenceIndex): RoleEvidence | undefined {
  const ids = new Set(result.role === "scout"
    ? result.candidates.filter(item => item.jobId === jobId).flatMap(item => item.evidenceIds)
    : result.findings.filter(item => item.jobId === jobId).flatMap(item => item.evidenceIds))
  return result.evidence.find(evidence => ids.has(evidence.id) && evidence.kind === "job" && evidence.ref === jobId
    && !index.conflicts.has(evidenceKey("job", jobId)) && sameEvidence(evidence, index.entries.get(evidenceKey("job", jobId))))
}

function sameEvidence(left: RoleEvidence, right: RoleEvidence | undefined): boolean {
  return right !== undefined && left.id === right.id && left.kind === right.kind && left.ref === right.ref && left.source === right.source
}

function evidenceKey(kind: string, ref: string): string { return `${kind}\u0000${ref}` }
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
