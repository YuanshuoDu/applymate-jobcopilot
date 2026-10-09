import {
  TASK_GRAPH_VERIFICATION_LIMITS,
  evaluateFindingsFromScoutDependency,
  parseFindingsFromScoutDependencyCheck,
  parseTaskGraphVerificationDependencyEvidence,
  parseTaskGraphVerificationEvidenceProjection,
} from "./task-graph-verification-cross-node.js"
import type {
  TaskGraphVerificationDependencyEvidence,
  TaskGraphVerificationEvidenceProjection,
  TaskGraphVerificationParsedProjection,
} from "./task-graph-verification-cross-node.js"

export {
  TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
  TASK_GRAPH_VERIFICATION_LIMITS,
  taskGraphVerificationDependencyNodeKeys,
  validateTaskGraphVerificationDependencySelectors,
} from "./task-graph-verification-cross-node.js"
export type {
  TaskGraphVerificationCandidateProjection,
  TaskGraphVerificationDependencyEvidence,
  TaskGraphVerificationDependencyGraphNode,
  TaskGraphVerificationEvidenceProjection,
  TaskGraphVerificationFindingProjection,
} from "./task-graph-verification-cross-node.js"

export const TASK_GRAPH_VERIFICATION_SCHEMA_VERSION = "agent-harness.v2.task-graph-verification.v1" as const
export type TaskGraphVerificationRole = "scout" | "analyst"
export type TaskGraphVerificationCheck =
  | Readonly<{ kind: "candidate_count_gte"; minimum: number }>
  | Readonly<{ kind: "finding_count_gte"; minimum: number }>
  | Readonly<{ kind: "evidence_count_gte"; minimum: number }>
  | Readonly<{ kind: "all_candidates_have_evidence"; minimumItems: number }>
  | Readonly<{ kind: "all_findings_have_evidence"; minimumItems: number }>
  /** Checks a reported number; it does not independently establish score correctness. */
  | Readonly<{
      kind: "reported_score_gte"
      minimumScore: number
      minimumFindings: number
      aggregation: "any" | "all"
    }>
  | Readonly<{ kind: "findings_from_scout_dependency"; dependencyNodeKey: string }>

export type TaskGraphVerificationCriterion = Readonly<{
  id: string
  check: TaskGraphVerificationCheck
}>
export type TaskGraphVerificationContract = Readonly<{
  schemaVersion: typeof TASK_GRAPH_VERIFICATION_SCHEMA_VERSION
  role: TaskGraphVerificationRole
  criteria: readonly TaskGraphVerificationCriterion[]
}>
export type TaskGraphVerificationReasonCode = "criteria_met" | "criterion_not_met" | "reported_score_below_minimum" | "contract_invalid" | "projection_invalid" | "role_mismatch" | "canonical_evidence_missing" | "canonical_evidence_invalid" | "canonical_evidence_ambiguous" | "result_invalid" | "result_ambiguous" | "result_evidence_unbound" | "repair_target_unresolved"
export type TaskGraphVerificationCriterionResult = Readonly<{ criterionId: string; status: "passed" | "failed" | "unverified"; reasonCode: TaskGraphVerificationReasonCode }>
export type TaskGraphVerificationEvaluation = Readonly<{ status: "passed" | "failed" | "unverified"; reasonCode: TaskGraphVerificationReasonCode; criteria: readonly TaskGraphVerificationCriterionResult[] }>

export type TaskGraphVerificationValidationError = Readonly<{
  code: "required" | "unsupported_template" | "invalid_shape" | "duplicate_id" | "unknown_check" | "role_mismatch"
  path: string
}>
export type TaskGraphVerificationValidation =
  | Readonly<{ ok: true; contract: TaskGraphVerificationContract }>
  | Readonly<{ ok: false; error: TaskGraphVerificationValidationError }>

const TEMPLATE_ROLES: Readonly<Record<string, TaskGraphVerificationRole>> = Object.freeze({ scout: "scout", analyst: "analyst" })
const CRITERION_ID = /^[a-z][a-z0-9._-]{0,63}$/

function invalid(code: TaskGraphVerificationValidationError["code"], path: string): TaskGraphVerificationValidation {
  return { ok: false, error: { code, path } }
}

function exactRecord(value: unknown, keys: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined
  try {
    if (Array.isArray(value)) return undefined
    const prototype = Object.getPrototypeOf(value)
    const ownKeys = Reflect.ownKeys(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if ((prototype !== Object.prototype && prototype !== null) || ownKeys.some(key => typeof key !== "string")
      || (ownKeys as string[]).sort().join(",") !== keys) return undefined
    const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of ownKeys as string[]) {
      const descriptor = descriptors[key]
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined
      record[key] = descriptor.value
    }
    return record
  } catch { return undefined }
}

function denseArray(value: unknown, maximum: number): unknown[] | undefined {
  return denseList(value, maximum, false)
}

function denseList(value: unknown, maximum: number, allowEmpty: boolean): unknown[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined
    const keys = Reflect.ownKeys(value)
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>
    const length = descriptors.length?.value
    if (!Number.isSafeInteger(length) || Number(length) < (allowEmpty ? 0 : 1) || Number(length) > maximum || keys.length !== Number(length) + 1) return undefined
    const items: unknown[] = []
    for (let index = 0; index < Number(length); index++) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined
      items.push(descriptor.value)
    }
    return items
  } catch { return undefined }
}

function positiveBoundedInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= TASK_GRAPH_VERIFICATION_LIMITS.maxItems
}

function parseCheck(value: unknown, role: TaskGraphVerificationRole, path: string): TaskGraphVerificationCheck | TaskGraphVerificationValidationError {
  let kind: string | undefined
  try {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, "kind")
      if (descriptor && "value" in descriptor && typeof descriptor.value === "string") kind = descriptor.value
    }
  } catch { /* Malformed proxy input is treated as an invalid check. */ }
  if (!kind) return { code: "invalid_shape", path }
  if (kind === "candidate_count_gte" && role === "scout") {
    const check = exactRecord(value, "kind,minimum")
    if (!check || !positiveBoundedInteger(check.minimum)) return { code: "invalid_shape", path }
    return { kind: "candidate_count_gte", minimum: check.minimum }
  }
  if (kind === "finding_count_gte" && role === "analyst") {
    const check = exactRecord(value, "kind,minimum")
    if (!check || !positiveBoundedInteger(check.minimum)) return { code: "invalid_shape", path }
    return { kind: "finding_count_gte", minimum: check.minimum }
  }
  if (kind === "evidence_count_gte") {
    const check = exactRecord(value, "kind,minimum")
    if (!check || !positiveBoundedInteger(check.minimum)) return { code: "invalid_shape", path }
    return { kind: "evidence_count_gte", minimum: check.minimum }
  }
  if (kind === "all_candidates_have_evidence" && role === "scout") {
    const check = exactRecord(value, "kind,minimumItems")
    if (!check || !positiveBoundedInteger(check.minimumItems)) return { code: "invalid_shape", path }
    return { kind: "all_candidates_have_evidence", minimumItems: check.minimumItems }
  }
  if (kind === "all_findings_have_evidence" && role === "analyst") {
    const check = exactRecord(value, "kind,minimumItems")
    if (!check || !positiveBoundedInteger(check.minimumItems)) return { code: "invalid_shape", path }
    return { kind: "all_findings_have_evidence", minimumItems: check.minimumItems }
  }
  if (kind === "reported_score_gte" && role === "analyst") {
    const check = exactRecord(value, "aggregation,kind,minimumFindings,minimumScore")
    if (!check || !positiveBoundedInteger(check.minimumFindings)
      || typeof check.minimumScore !== "number" || !Number.isFinite(check.minimumScore)
      || check.minimumScore < 0 || check.minimumScore > TASK_GRAPH_VERIFICATION_LIMITS.maxScore
      || (check.aggregation !== "any" && check.aggregation !== "all")) return { code: "invalid_shape", path }
    return {
      kind: "reported_score_gte", minimumScore: check.minimumScore,
      minimumFindings: check.minimumFindings, aggregation: check.aggregation,
    }
  }
  if (kind === "findings_from_scout_dependency") return parseFindingsFromScoutDependencyCheck(value, role, path)
  return { code: "unknown_check", path }
}

/** Validates model-authored checks against the server's fixed read-only template registry. */
export function validateTaskGraphVerificationContract(value: unknown, templateId: string): TaskGraphVerificationValidation {
  const role = Object.hasOwn(TEMPLATE_ROLES, templateId) ? TEMPLATE_ROLES[templateId] : undefined
  if (!role) return invalid("unsupported_template", "verification")
  const contract = exactRecord(value, "criteria,role,schemaVersion")
  if (!contract || contract.schemaVersion !== TASK_GRAPH_VERIFICATION_SCHEMA_VERSION) return invalid("invalid_shape", "verification")
  const criteriaInput = denseArray(contract.criteria, TASK_GRAPH_VERIFICATION_LIMITS.maxCriteria)
  if (!criteriaInput) return invalid("invalid_shape", "verification")
  if (contract.role !== role) return invalid("role_mismatch", "verification.role")
  const criteria: TaskGraphVerificationCriterion[] = []
  const ids = new Set<string>()
  for (let index = 0; index < criteriaInput.length; index++) {
    const path = `verification.criteria[${index}]`
    const row = exactRecord(criteriaInput[index], "check,id")
    if (!row || typeof row.id !== "string" || row.id.length > TASK_GRAPH_VERIFICATION_LIMITS.maxCriterionIdLength || !CRITERION_ID.test(row.id)) {
      return invalid("invalid_shape", path)
    }
    if (ids.has(row.id)) return invalid("duplicate_id", `${path}.id`)
    const check = parseCheck(row.check, role, `${path}.check`)
    if ("code" in check) return invalid(check.code, check.path)
    ids.add(row.id)
    criteria.push({ id: row.id, check })
  }
  return {
    ok: true,
    contract: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role, criteria },
  }
}

export function taskGraphVerificationRole(templateId: string): TaskGraphVerificationRole | undefined {
  return Object.hasOwn(TEMPLATE_ROLES, templateId) ? TEMPLATE_ROLES[templateId] : undefined
}
function unverifiedEvaluation(contract: TaskGraphVerificationContract, reasonCode: TaskGraphVerificationReasonCode): TaskGraphVerificationEvaluation {
  return { status: "unverified", reasonCode, criteria: contract.criteria.map(c => ({ criterionId: c.id, status: "unverified", reasonCode })) }
}
type CheckEvaluation = "passed" | "criterion_not_met" | "reported_score_below_minimum"
function evaluateCheck(check: TaskGraphVerificationCheck, p: TaskGraphVerificationParsedProjection): CheckEvaluation {
  if (check.kind === "findings_from_scout_dependency") return "criterion_not_met"
  if (check.kind === "candidate_count_gte") return p.role === "scout" && p.items.length >= check.minimum ? "passed" : "criterion_not_met"
  if (check.kind === "finding_count_gte") return p.role === "analyst" && p.items.length >= check.minimum ? "passed" : "criterion_not_met"
  if (check.kind === "evidence_count_gte") return p.evidenceIds.length >= check.minimum ? "passed" : "criterion_not_met"
  if (check.kind === "all_candidates_have_evidence" || check.kind === "all_findings_have_evidence") return p.items.length >= check.minimumItems ? "passed" : "criterion_not_met"
  if (p.items.length < check.minimumFindings) return "criterion_not_met"
  const meets = (item: TaskGraphVerificationParsedProjection["items"][number]) => (item.score ?? -1) >= check.minimumScore
  return (check.aggregation === "any" ? p.items.some(meets) : p.items.every(meets)) ? "passed" : "reported_score_below_minimum"
}
/** Evaluates an already validated server-owned contract against a sanitized, evidence-rebound projection. Template validation stays at the planner boundary. */
export function evaluateTaskGraphVerification(
  contract: TaskGraphVerificationContract,
  projectionValue: TaskGraphVerificationEvidenceProjection,
  dependencyEvidence?: TaskGraphVerificationDependencyEvidence,
): TaskGraphVerificationEvaluation {
  try {
    if (contract.schemaVersion !== TASK_GRAPH_VERIFICATION_SCHEMA_VERSION || (contract.role !== "scout" && contract.role !== "analyst") || !Array.isArray(contract.criteria) || contract.criteria.length < 1 || contract.criteria.length > TASK_GRAPH_VERIFICATION_LIMITS.maxCriteria) return { status: "unverified", reasonCode: "contract_invalid", criteria: [] }
    const parsed = parseTaskGraphVerificationEvidenceProjection(projectionValue)
    if (!parsed.ok) return unverifiedEvaluation(contract, parsed.reasonCode)
    if (parsed.value.role !== contract.role) return unverifiedEvaluation(contract, "role_mismatch")
    const dependencies = parseTaskGraphVerificationDependencyEvidence(contract, dependencyEvidence)
    if (!dependencies) return unverifiedEvaluation(contract, "canonical_evidence_invalid")
    const findingJobIds = parsed.value.role === "analyst" ? parsed.value.items.map(item => item.jobId) : []
    const criteria = contract.criteria.map(c => {
      const result = c.check.kind === "findings_from_scout_dependency"
        ? evaluateFindingsFromScoutDependency(c.check.dependencyNodeKey, findingJobIds, dependencies)
        : evaluateCheck(c.check, parsed.value)
      return result === "passed" ? { criterionId: c.id, status: "passed" as const, reasonCode: "criteria_met" as const } : { criterionId: c.id, status: "failed" as const, reasonCode: result }
    })
    const failed = criteria.find(c => c.status === "failed")
    return failed ? { status: "failed", reasonCode: failed.reasonCode, criteria } : { status: "passed", reasonCode: "criteria_met", criteria }
  } catch { return { status: "unverified", reasonCode: "contract_invalid", criteria: [] } }
}
