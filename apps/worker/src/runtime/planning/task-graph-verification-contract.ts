import {
  TASK_GRAPH_VERIFICATION_LIMITS,
  parseFindingsCoverScoutCandidatesCheck,
  parseFindingsFromScoutDependencyCheck,
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
  | Readonly<{ kind: "reported_score_gte"; minimumScore: number; minimumFindings: number; aggregation: "any" | "all" }>
  | Readonly<{ kind: "findings_from_scout_dependency"; dependencyNodeKey: string }>
  | Readonly<{ kind: "findings_cover_scout_candidates_gte"; dependencyNodeKey: string; minimumPercent: number }>
  | Readonly<{ kind: "findings_from_scout_union"; dependencyNodeKeys: readonly string[] }>
  | Readonly<{ kind: "findings_cover_scout_candidate_union_gte"; dependencyNodeKeys: readonly string[]; minimumPercent: number }>

export type TaskGraphVerificationCriterion = Readonly<{ id: string; check: TaskGraphVerificationCheck }>
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
const UNION_SOURCE_LIMIT = 8
// Matches TASK_GRAPH_LIMITS.maxKeyLength without importing task-graph.ts at runtime.
const DEPENDENCY_KEY_LIMIT = 128

function invalid(code: TaskGraphVerificationValidationError["code"], path: string): TaskGraphVerificationValidation {
  return { ok: false, error: { code, path } }
}

function exactRecord(value: unknown, keys: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined
  try {
    if (Array.isArray(value)) return undefined
    const prototype = Object.getPrototypeOf(value), ownKeys = Reflect.ownKeys(value)
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

function denseList(value: unknown, maximum: number, allowEmpty: boolean): unknown[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined
    const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>
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

function densePlainSelectorList(value: unknown): string[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined
    const keys = denseList(value, UNION_SOURCE_LIMIT, false)
    if (!keys || keys.length < 2 || keys.some(key => typeof key !== "string" || key.trim() !== key || key.length < 1 || key.length > DEPENDENCY_KEY_LIMIT)
      || new Set(keys).size !== keys.length) return undefined
    return keys as string[]
  } catch { return undefined }
}

function positiveBoundedInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= TASK_GRAPH_VERIFICATION_LIMITS.maxItems
}

function parseUnionCheck(
  value: unknown, kind: "findings_from_scout_union" | "findings_cover_scout_candidate_union_gte",
  role: TaskGraphVerificationRole, path: string,
): TaskGraphVerificationCheck | TaskGraphVerificationValidationError {
  if (role !== "analyst") return { code: "unknown_check", path }
  const withPercent = kind === "findings_cover_scout_candidate_union_gte"
  const row = exactRecord(value, withPercent ? "dependencyNodeKeys,kind,minimumPercent" : "dependencyNodeKeys,kind")
  const dependencyNodeKeys = row && densePlainSelectorList(row.dependencyNodeKeys)
  if (!row || !dependencyNodeKeys || withPercent
    && (!Number.isSafeInteger(row.minimumPercent) || Number(row.minimumPercent) < 1 || Number(row.minimumPercent) > 100)) {
    return { code: "invalid_shape", path }
  }
  return withPercent
    ? { kind, dependencyNodeKeys, minimumPercent: Number(row.minimumPercent) }
    : { kind, dependencyNodeKeys }
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
    return { kind: "reported_score_gte", minimumScore: check.minimumScore, minimumFindings: check.minimumFindings, aggregation: check.aggregation }
  }
  if (kind === "findings_from_scout_dependency") return parseFindingsFromScoutDependencyCheck(value, role, path)
  if (kind === "findings_cover_scout_candidates_gte") return parseFindingsCoverScoutCandidatesCheck(value, role, path)
  if (kind === "findings_from_scout_union" || kind === "findings_cover_scout_candidate_union_gte") return parseUnionCheck(value, kind, role, path)
  return { code: "unknown_check", path }
}

/** Validates model-authored checks against the server's fixed read-only template registry. */
export function validateTaskGraphVerificationContract(value: unknown, templateId: string): TaskGraphVerificationValidation {
  const role = Object.hasOwn(TEMPLATE_ROLES, templateId) ? TEMPLATE_ROLES[templateId] : undefined
  if (!role) return invalid("unsupported_template", "verification")
  const contract = exactRecord(value, "criteria,role,schemaVersion")
  if (!contract || contract.schemaVersion !== TASK_GRAPH_VERIFICATION_SCHEMA_VERSION) return invalid("invalid_shape", "verification")
  const criteriaInput = denseList(contract.criteria, TASK_GRAPH_VERIFICATION_LIMITS.maxCriteria, false)
  if (!criteriaInput) return invalid("invalid_shape", "verification")
  if (contract.role !== role) return invalid("role_mismatch", "verification.role")
  const criteria: TaskGraphVerificationCriterion[] = [], ids = new Set<string>()
  for (let index = 0; index < criteriaInput.length; index++) {
    const path = `verification.criteria[${index}]`, row = exactRecord(criteriaInput[index], "check,id")
    if (!row || typeof row.id !== "string" || row.id.length > TASK_GRAPH_VERIFICATION_LIMITS.maxCriterionIdLength || !CRITERION_ID.test(row.id)) {
      return invalid("invalid_shape", path)
    }
    if (ids.has(row.id)) return invalid("duplicate_id", `${path}.id`)
    const check = parseCheck(row.check, role, `${path}.check`)
    if ("code" in check) return invalid(check.code, check.path)
    ids.add(row.id)
    criteria.push({ id: row.id, check })
  }
  return { ok: true, contract: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role, criteria } }
}

export function taskGraphVerificationRole(templateId: string): TaskGraphVerificationRole | undefined {
  return Object.hasOwn(TEMPLATE_ROLES, templateId) ? TEMPLATE_ROLES[templateId] : undefined
}
