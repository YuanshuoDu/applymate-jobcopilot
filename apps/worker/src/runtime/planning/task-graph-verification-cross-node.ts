import type {
  TaskGraphVerificationCheck,
  TaskGraphVerificationContract,
  TaskGraphVerificationRole,
  TaskGraphVerificationValidationError,
} from "./task-graph-verification.js"

export const TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION = "agent-harness.v2.task-graph-verification-evidence.v1" as const
export const TASK_GRAPH_VERIFICATION_LIMITS = Object.freeze({
  maxCriteria: 8,
  maxItems: 50,
  maxCriterionIdLength: 64,
  maxScore: 10,
})

export type TaskGraphVerificationCandidateProjection = Readonly<{ jobId: string; evidenceIds: readonly string[] }>
export type TaskGraphVerificationFindingProjection = Readonly<{ jobId: string; score: number; evidenceIds: readonly string[] }>
export type TaskGraphVerificationEvidenceProjection =
  | Readonly<{ schemaVersion: typeof TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION; role: "scout"; candidates: readonly TaskGraphVerificationCandidateProjection[]; evidenceIds: readonly string[] }>
  | Readonly<{ schemaVersion: typeof TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION; role: "analyst"; findings: readonly TaskGraphVerificationFindingProjection[]; evidenceIds: readonly string[] }>
export type TaskGraphVerificationDependencyEvidence = ReadonlyMap<string, TaskGraphVerificationEvidenceProjection>

type ParsedItem = Readonly<{ jobId: string; evidenceIds: readonly string[]; score?: number }>
export type TaskGraphVerificationParsedProjection = Readonly<{ role: TaskGraphVerificationRole; items: readonly ParsedItem[]; evidenceIds: readonly string[] }>
export type TaskGraphVerificationProjectionParse =
  | Readonly<{ ok: true; value: TaskGraphVerificationParsedProjection }>
  | Readonly<{ ok: false; reasonCode: Exclude<import("./task-graph-verification.js").TaskGraphVerificationReasonCode, "criteria_met" | "criterion_not_met" | "reported_score_below_minimum" | "contract_invalid"> }>

export type TaskGraphVerificationDependencyGraphNode = Readonly<{
  key: string
  templateId: string
  dependsOn: readonly string[]
  verificationDisposition?: string
  verification?: TaskGraphVerificationContract
}>

function boundedText(value: unknown, maximum = 256): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= maximum }
function canonicalReadEvidenceId(value: unknown): value is string {
  return boundedText(value, 269) && ["read:job:", "read:persona:", "read:resume:"].some(prefix => value.startsWith(prefix) && value.slice(prefix.length).trim().length > 0)
}

function exactRecord(value: unknown, keys: string): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
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

export function parseTaskGraphVerificationEvidenceProjection(value: unknown): TaskGraphVerificationProjectionParse {
  let role: TaskGraphVerificationRole | undefined
  try {
    const descriptor = value && typeof value === "object" && !Array.isArray(value) ? Object.getOwnPropertyDescriptor(value, "role") : undefined
    if (descriptor && "value" in descriptor && (descriptor.value === "scout" || descriptor.value === "analyst")) role = descriptor.value
  } catch { /* Malformed projections are unverified. */ }
  if (!role) return { ok: false, reasonCode: "projection_invalid" }
  const keys = role === "scout" ? "candidates,evidenceIds,role,schemaVersion" : "evidenceIds,findings,role,schemaVersion"
  const row = exactRecord(value, keys)
  if (!row || row.schemaVersion !== TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION || row.role !== role) return { ok: false, reasonCode: "projection_invalid" }
  const ids = denseList(row.evidenceIds, TASK_GRAPH_VERIFICATION_LIMITS.maxItems, false)
  if (!ids) return { ok: false, reasonCode: Array.isArray(row.evidenceIds) && row.evidenceIds.length === 0 ? "canonical_evidence_missing" : "canonical_evidence_invalid" }
  if (ids.some(id => !canonicalReadEvidenceId(id))) return { ok: false, reasonCode: "canonical_evidence_invalid" }
  const evidenceIds = ids as string[], canonicalIds = new Set(evidenceIds)
  if (canonicalIds.size !== evidenceIds.length) return { ok: false, reasonCode: "canonical_evidence_ambiguous" }
  const rows = denseList(role === "scout" ? row.candidates : row.findings, TASK_GRAPH_VERIFICATION_LIMITS.maxItems, true)
  if (!rows) return { ok: false, reasonCode: "result_invalid" }
  const seenJobs = new Set<string>(), items: ParsedItem[] = []
  for (const valueItem of rows) {
    const item = role === "scout" ? exactRecord(valueItem, "evidenceIds,jobId") : exactRecord(valueItem, "evidenceIds,jobId,score")
    if (!item || !boundedText(item.jobId)) return { ok: false, reasonCode: "result_invalid" }
    if (seenJobs.has(item.jobId)) return { ok: false, reasonCode: "result_ambiguous" }
    seenJobs.add(item.jobId)
    const refs = denseList(item.evidenceIds, TASK_GRAPH_VERIFICATION_LIMITS.maxItems, false) as string[] | undefined
    if (!refs || refs.some(ref => !boundedText(ref, 269)) || new Set(refs).size !== refs.length
      || (role === "analyst" && (typeof item.score !== "number" || !Number.isFinite(item.score) || item.score < 0 || item.score > TASK_GRAPH_VERIFICATION_LIMITS.maxScore))) return { ok: false, reasonCode: "result_invalid" }
    if (refs.some(ref => !canonicalIds.has(ref)) || !refs.includes("read:job:" + item.jobId)) return { ok: false, reasonCode: "result_evidence_unbound" }
    items.push({ jobId: item.jobId, evidenceIds: refs, ...(role === "analyst" ? { score: item.score as number } : {}) })
  }
  return { ok: true, value: { role, items, evidenceIds } }
}

export function parseFindingsFromScoutDependencyCheck(
  value: unknown,
  role: TaskGraphVerificationRole,
  path: string,
): TaskGraphVerificationCheck | TaskGraphVerificationValidationError {
  const check = exactRecord(value, "dependencyNodeKey,kind")
  if (role !== "analyst") return { code: "unknown_check", path }
  if (!check || typeof check.dependencyNodeKey !== "string" || check.dependencyNodeKey.trim() !== check.dependencyNodeKey
    || check.dependencyNodeKey.length < 1 || check.dependencyNodeKey.length > 128) return { code: "invalid_shape", path }
  return { kind: "findings_from_scout_dependency", dependencyNodeKey: check.dependencyNodeKey }
}

export function taskGraphVerificationDependencyNodeKeys(contract: TaskGraphVerificationContract): string[] {
  return [...new Set(contract.criteria
    .filter(item => item.check.kind === "findings_from_scout_dependency")
    .map(item => item.check.kind === "findings_from_scout_dependency" ? item.check.dependencyNodeKey : ""))].sort()
}

/** Call with nodes normalized by the strict snapshot parser and from one graph only. */
export function validateTaskGraphVerificationDependencySelectors(nodes: readonly TaskGraphVerificationDependencyGraphNode[]): boolean {
  const byKey = new Map<string, TaskGraphVerificationDependencyGraphNode>()
  for (const node of nodes) {
    if (!boundedText(node.key, 128) || byKey.has(node.key)) return false
    byKey.set(node.key, node)
  }
  for (const node of nodes) {
    if (node.templateId !== "analyst" || node.verificationDisposition !== "typed" || node.verification?.role !== "analyst") continue
    for (const criterion of node.verification.criteria) {
      if (criterion.check.kind !== "findings_from_scout_dependency") continue
      const source = byKey.get(criterion.check.dependencyNodeKey)
      if (!source || !node.dependsOn.includes(source.key) || source.templateId !== "scout"
        || source.verificationDisposition !== "typed" || source.verification?.role !== "scout") return false
    }
  }
  return true
}

export function evaluateFindingsFromScoutDependency(
  dependencyNodeKey: string,
  findingJobIds: readonly string[],
  dependencies: ReadonlyMap<string, TaskGraphVerificationParsedProjection>,
): "passed" | "criterion_not_met" {
  const source = dependencies.get(dependencyNodeKey)
  if (!source || source.role !== "scout") return "criterion_not_met"
  const candidateIds = new Set(source.items.map(item => item.jobId))
  return findingJobIds.every(jobId => candidateIds.has(jobId)) ? "passed" : "criterion_not_met"
}

export function parseTaskGraphVerificationDependencyEvidence(
  contract: TaskGraphVerificationContract,
  evidence?: TaskGraphVerificationDependencyEvidence,
): ReadonlyMap<string, TaskGraphVerificationParsedProjection> | undefined {
  const expected = taskGraphVerificationDependencyNodeKeys(contract)
  if (expected.length === 0) return evidence === undefined || evidence instanceof Map && evidence.size === 0 ? new Map() : undefined
  if (!(evidence instanceof Map) || evidence.size !== expected.length) return undefined
  const parsed = new Map<string, TaskGraphVerificationParsedProjection>()
  for (const key of expected) {
    if (!evidence.has(key)) return undefined
    const value = parseTaskGraphVerificationEvidenceProjection(evidence.get(key))
    if (!value.ok || value.value.role !== "scout") return undefined
    parsed.set(key, value.value)
  }
  return parsed
}
