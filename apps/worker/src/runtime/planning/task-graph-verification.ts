import {
  TASK_GRAPH_VERIFICATION_LIMITS,
  evaluateFindingsCoverScoutCandidates,
  evaluateFindingsFromScoutDependency,
  parseTaskGraphVerificationDependencyEvidence,
  parseTaskGraphVerificationEvidenceProjection,
  taskGraphVerificationDependencyNodeKeys,
} from "./task-graph-verification-cross-node.js"
import type { TaskGraphVerificationDependencyEvidence, TaskGraphVerificationEvidenceProjection, TaskGraphVerificationParsedProjection } from "./task-graph-verification-cross-node.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "./task-graph-verification-contract.js"
import type { TaskGraphVerificationCheck, TaskGraphVerificationContract, TaskGraphVerificationEvaluation, TaskGraphVerificationReasonCode } from "./task-graph-verification-contract.js"
import { evaluateFindingsCoverScoutCandidateUnion, evaluateFindingsFromScoutUnion } from "./task-graph-verification-scout-union.js"

export { TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, TASK_GRAPH_VERIFICATION_LIMITS, taskGraphVerificationDependencyNodeKeys, validateTaskGraphVerificationDependencySelectors } from "./task-graph-verification-cross-node.js"
export type { TaskGraphVerificationCandidateProjection, TaskGraphEmptyDiscoveryReceiptProjection, TaskGraphVerificationDependencyEvidence, TaskGraphVerificationDependencyGraphNode, TaskGraphVerificationEvidenceProjection, TaskGraphVerificationFindingProjection } from "./task-graph-verification-cross-node.js"
export { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, taskGraphVerificationRole, validateTaskGraphVerificationContract } from "./task-graph-verification-contract.js"
export type { TaskGraphVerificationCheck, TaskGraphVerificationContract, TaskGraphVerificationCriterion, TaskGraphVerificationCriterionResult, TaskGraphVerificationEvaluation, TaskGraphVerificationReasonCode, TaskGraphVerificationRole, TaskGraphVerificationValidation, TaskGraphVerificationValidationError } from "./task-graph-verification-contract.js"
export { remapTaskGraphVerificationCheckDependencies, taskGraphVerificationCheckDependencyNodeKeys } from "./task-graph-verification-scout-union.js"

function exactRecord(value: unknown, keys: string): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const ownKeys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value)
    if ((Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      || ownKeys.some(key => typeof key !== "string") || (ownKeys as string[]).sort().join(",") !== keys) return undefined
    const row: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of ownKeys as string[]) {
      const descriptor = descriptors[key]
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined
      row[key] = descriptor.value
    }
    return row
  } catch { return undefined }
}

function denseArray(value: unknown, maximum: number): unknown[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined
    const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>
    const length = descriptors.length?.value
    if (!Number.isSafeInteger(length) || Number(length) < 1 || Number(length) > maximum || keys.length !== Number(length) + 1) return undefined
    const items: unknown[] = []
    for (let index = 0; index < Number(length); index++) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined
      items.push(descriptor.value)
    }
    return items
  } catch { return undefined }
}

/** The scheduled continuation may bind Prepare only to its completed, sole direct Analyst dependency. */
export function validateScheduledPrepareDependencyEvidence(value: unknown): boolean {
  const row = exactRecord(value, "analyst,prepare")
  const prepare = row && exactRecord(row.prepare, "dependsOn,key,templateId")
  const analyst = row && exactRecord(row.analyst, "key,status,templateId")
  const dependsOn = prepare && denseArray(prepare.dependsOn, 1)
  const validKey = (key: unknown) => typeof key === "string" && key.length > 0 && key.length <= 128 && key.trim() === key
  return Boolean(prepare && analyst && dependsOn && prepare.templateId === "prepare" && analyst.templateId === "analyst"
    && validKey(prepare.key) && validKey(analyst.key) && prepare.key !== analyst.key && analyst.status === "completed"
    && dependsOn.length === 1 && dependsOn[0] === analyst.key)
}

function unverifiedEvaluation(contract: TaskGraphVerificationContract, reasonCode: TaskGraphVerificationReasonCode): TaskGraphVerificationEvaluation {
  return { status: "unverified", reasonCode, criteria: contract.criteria.map(c => ({ criterionId: c.id, status: "unverified", reasonCode })) }
}
type CheckEvaluation = "passed" | "criterion_not_met" | "reported_score_below_minimum"
function evaluateCheck(check: TaskGraphVerificationCheck, p: TaskGraphVerificationParsedProjection, verifiedEmptyDiscovery: boolean): CheckEvaluation {
  if (check.kind === "findings_from_scout_dependency" || check.kind === "findings_cover_scout_candidates_gte"
    || check.kind === "findings_from_scout_union" || check.kind === "findings_cover_scout_candidate_union_gte") return "criterion_not_met"
  if (check.kind === "candidate_count_gte") return p.role === "scout" && (p.items.length >= check.minimum || verifiedEmptyDiscovery && p.items.length === 0) ? "passed" : "criterion_not_met"
  if (check.kind === "finding_count_gte") return p.role === "analyst" && (p.items.length >= check.minimum || verifiedEmptyDiscovery && p.items.length === 0) ? "passed" : "criterion_not_met"
  if (check.kind === "evidence_count_gte") return (verifiedEmptyDiscovery ? 1 : p.emptyDiscoveryDigest ? 0 : p.evidenceIds.length) >= check.minimum ? "passed" : "criterion_not_met"
  if (check.kind === "all_candidates_have_evidence" || check.kind === "all_findings_have_evidence") return verifiedEmptyDiscovery && p.items.length === 0 || p.items.length >= check.minimumItems ? "passed" : "criterion_not_met"
  if (verifiedEmptyDiscovery && p.items.length === 0) return "passed"
  if (p.items.length < check.minimumFindings) return "criterion_not_met"
  const meets = (item: TaskGraphVerificationParsedProjection["items"][number]) => (item.score ?? -1) >= check.minimumScore
  return (check.aggregation === "any" ? p.items.some(meets) : p.items.every(meets)) ? "passed" : "reported_score_below_minimum"
}

/** Evaluates an already validated server-owned contract against a sanitized, evidence-rebound projection. Template validation stays at the planner boundary. */
export function evaluateTaskGraphVerification(contract: TaskGraphVerificationContract, projectionValue: TaskGraphVerificationEvidenceProjection, dependencyEvidence?: TaskGraphVerificationDependencyEvidence): TaskGraphVerificationEvaluation {
  return evaluateTaskGraphVerificationInternal(contract, projectionValue, dependencyEvidence)
}

/** PG verifier only: digest must come from owner/attempt-bound persisted discovery receipts. */
export function evaluateTaskGraphVerificationWithVerifiedEmptyDiscovery(contract: TaskGraphVerificationContract, projectionValue: TaskGraphVerificationEvidenceProjection, dependencyEvidence: TaskGraphVerificationDependencyEvidence | undefined, verifiedDigest: string): TaskGraphVerificationEvaluation {
  if (!/^[a-f0-9]{64}$/.test(verifiedDigest)) return unverifiedEvaluation(contract, "canonical_evidence_invalid")
  return evaluateTaskGraphVerificationInternal(contract, projectionValue, dependencyEvidence, verifiedDigest)
}

function evaluateTaskGraphVerificationInternal(contract: TaskGraphVerificationContract, projectionValue: TaskGraphVerificationEvidenceProjection, dependencyEvidence?: TaskGraphVerificationDependencyEvidence, verifiedEmptyDiscoveryDigest?: string): TaskGraphVerificationEvaluation {
  try {
    if (contract.schemaVersion !== TASK_GRAPH_VERIFICATION_SCHEMA_VERSION || (contract.role !== "scout" && contract.role !== "analyst") || !Array.isArray(contract.criteria) || contract.criteria.length < 1 || contract.criteria.length > TASK_GRAPH_VERIFICATION_LIMITS.maxCriteria) return { status: "unverified", reasonCode: "contract_invalid", criteria: [] }
    const parsed = parseTaskGraphVerificationEvidenceProjection(projectionValue)
    if (!parsed.ok) return unverifiedEvaluation(contract, parsed.reasonCode)
    if (parsed.value.role !== contract.role) return unverifiedEvaluation(contract, "role_mismatch")
    const dependencies = parseTaskGraphVerificationDependencyEvidence(contract, dependencyEvidence)
    if (!dependencies) return unverifiedEvaluation(contract, "canonical_evidence_invalid")
    const findingJobIds = parsed.value.role === "analyst" ? parsed.value.items.map(item => item.jobId) : []
    const verifiedEmptyDiscovery = Boolean(verifiedEmptyDiscoveryDigest && parsed.value.items.length === 0
      && parsed.value.emptyDiscoveryDigest === verifiedEmptyDiscoveryDigest
      && (parsed.value.role === "scout" ? parsed.value.evidenceIds.length === 1
        && parsed.value.evidenceIds[0] === `read:source:jobs.discover:${verifiedEmptyDiscoveryDigest}`
        : singleVerifiedEmptyScoutDependency(contract, dependencies, verifiedEmptyDiscoveryDigest)))
    const criteria = contract.criteria.map(c => {
      const check = c.check
      const result = check.kind === "findings_from_scout_dependency"
        ? evaluateFindingsFromScoutDependency(check.dependencyNodeKey, findingJobIds, dependencies, verifiedEmptyDiscovery ? verifiedEmptyDiscoveryDigest : undefined)
        : check.kind === "findings_cover_scout_candidates_gte"
          ? evaluateFindingsCoverScoutCandidates(check.dependencyNodeKey, findingJobIds, dependencies, check.minimumPercent, verifiedEmptyDiscovery ? verifiedEmptyDiscoveryDigest : undefined)
          : check.kind === "findings_from_scout_union"
            ? evaluateFindingsFromScoutUnion(check.dependencyNodeKeys, findingJobIds, dependencies)
            : check.kind === "findings_cover_scout_candidate_union_gte"
              ? evaluateFindingsCoverScoutCandidateUnion(check.dependencyNodeKeys, findingJobIds, dependencies, check.minimumPercent)
              : evaluateCheck(check, parsed.value, verifiedEmptyDiscovery)
      return result === "passed" ? { criterionId: c.id, status: "passed" as const, reasonCode: "criteria_met" as const } : { criterionId: c.id, status: "failed" as const, reasonCode: result }
    })
    const failed = criteria.find(c => c.status === "failed")
    return failed ? { status: "failed", reasonCode: failed.reasonCode, criteria } : { status: "passed", reasonCode: "criteria_met", criteria }
  } catch { return { status: "unverified", reasonCode: "contract_invalid", criteria: [] } }
}

function singleVerifiedEmptyScoutDependency(contract: TaskGraphVerificationContract, dependencies: ReadonlyMap<string, TaskGraphVerificationParsedProjection>, digest: string): boolean {
  const keys = taskGraphVerificationDependencyNodeKeys(contract)
  if (keys.length !== 1) return false
  const source = dependencies.get(keys[0]!)
  return source?.role === "scout" && source.items.length === 0 && source.emptyDiscoveryDigest === digest
    && source.evidenceIds.length === 1 && source.evidenceIds[0] === `read:source:jobs.discover:${digest}`
}
