import type { TaskGraphVerificationReasonCode } from "../planning/task-graph-verification.js"

export const TASK_GRAPH_VERIFIER_VERSION = "agent-harness.v2.task-graph-verifier.v1" as const
const CRITERION_ID = /^[a-z][a-z0-9._-]{0,63}$/
const DIGEST = /^[a-f0-9]{64}$/
const MAX_BINDINGS = 8
const MAX_KEY_LENGTH = 128
const REPORT_REASONS = new Set<TaskGraphVerificationReasonCode>([
  "criteria_met", "criterion_not_met", "reported_score_below_minimum", "contract_invalid", "projection_invalid",
  "role_mismatch", "canonical_evidence_missing", "canonical_evidence_invalid", "canonical_evidence_ambiguous",
  "result_invalid", "result_ambiguous", "result_evidence_unbound", "repair_target_unresolved",
])

export type TaskGraphVerificationReport = Readonly<{
  verifierVersion: typeof TASK_GRAPH_VERIFIER_VERSION
  status: "passed" | "failed" | "unverified"
  reasonCode: TaskGraphVerificationReasonCode
  criteria: readonly Readonly<{ criterionId: string; status: "passed" | "failed" | "unverified"; reasonCode: TaskGraphVerificationReasonCode }>[]
  evidenceDigest: string | null
  resultDigest: string | null
}>

export type TaskGraphVerificationDependencyBinding = Readonly<{
  nodeKey: string
  taskId: string
  attemptCount: number
  nodeDigest: string
  resultDigest: string
  evidenceDigest: string
  reportDigest: string
}>

export type TaskGraphStoredVerificationReport = TaskGraphVerificationReport & Readonly<{
  dependencyBindings?: readonly TaskGraphVerificationDependencyBinding[]
}>

function record(value: unknown): value is Record<string, unknown> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).every(key => typeof key === "string")
  } catch { return false }
}

function exact(value: Record<string, unknown>, keys: string): boolean {
  return Reflect.ownKeys(value).sort().join(",") === keys
}

function dense(value: unknown, min: number, max: number): value is unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) return false
  return Array.from({ length: value.length }, (_, index) => String(index)).every(key => Object.hasOwn(value, key))
}

function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= MAX_KEY_LENGTH
}

function compareKeys(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }

function parseBindings(value: unknown): readonly TaskGraphVerificationDependencyBinding[] | undefined {
  if (!dense(value, 1, MAX_BINDINGS)) return undefined
  const output: TaskGraphVerificationDependencyBinding[] = []
  let previous: string | undefined
  for (const itemValue of value) {
    if (!record(itemValue) || !exact(itemValue, "attemptCount,evidenceDigest,nodeDigest,nodeKey,reportDigest,resultDigest,taskId")
      || !boundedId(itemValue.nodeKey) || !boundedId(itemValue.taskId) || !Number.isSafeInteger(itemValue.attemptCount) || Number(itemValue.attemptCount) < 1
      || ![itemValue.nodeDigest, itemValue.resultDigest, itemValue.evidenceDigest, itemValue.reportDigest].every(digest => typeof digest === "string" && DIGEST.test(digest))
      || previous !== undefined && compareKeys(previous, itemValue.nodeKey) >= 0) return undefined
    previous = itemValue.nodeKey
    output.push({
      nodeKey: itemValue.nodeKey,
      taskId: itemValue.taskId,
      attemptCount: itemValue.attemptCount as number,
      nodeDigest: itemValue.nodeDigest as string,
      resultDigest: itemValue.resultDigest as string,
      evidenceDigest: itemValue.evidenceDigest as string,
      reportDigest: itemValue.reportDigest as string,
    })
  }
  return output
}

/** Parses the reserved server-owned report envelope; optional expected keys bind a typed cross-node contract. */
export function parseStoredTaskGraphVerificationReport(
  value: unknown,
  criterionIds: readonly string[],
  expectedDependencyNodeKeys?: readonly string[],
): TaskGraphStoredVerificationReport | undefined {
  if (!record(value)) return undefined
  const hasBindings = Object.hasOwn(value, "dependencyBindings")
  if (!exact(value, hasBindings
    ? "criteria,dependencyBindings,evidenceDigest,reasonCode,resultDigest,status,verifierVersion"
    : "criteria,evidenceDigest,reasonCode,resultDigest,status,verifierVersion")
    || value.verifierVersion !== TASK_GRAPH_VERIFIER_VERSION
    || !["passed", "failed", "unverified"].includes(String(value.status))
    || typeof value.reasonCode !== "string" || !REPORT_REASONS.has(value.reasonCode as TaskGraphVerificationReasonCode)
    || !(value.status === "unverified"
      ? value.evidenceDigest === null || typeof value.evidenceDigest === "string" && DIGEST.test(value.evidenceDigest)
      : typeof value.evidenceDigest === "string" && DIGEST.test(value.evidenceDigest))
    || !(value.resultDigest === null || typeof value.resultDigest === "string" && DIGEST.test(value.resultDigest))
    || !dense(value.criteria, 1, 8) || value.criteria.length !== criterionIds.length) return undefined

  const criteria: NonNullable<TaskGraphVerificationReport["criteria"]>[number][] = []
  for (let index = 0; index < value.criteria.length; index += 1) {
    const item = value.criteria[index]
    if (!record(item) || !exact(item, "criterionId,reasonCode,status") || item.criterionId !== criterionIds[index]
      || typeof item.criterionId !== "string" || !CRITERION_ID.test(item.criterionId)
      || typeof item.reasonCode !== "string" || !REPORT_REASONS.has(item.reasonCode as TaskGraphVerificationReasonCode)
      || !["passed", "failed", "unverified"].includes(String(item.status))) return undefined
    if (item.status === "passed" && item.reasonCode !== "criteria_met"
      || item.status === "failed" && item.reasonCode !== "criterion_not_met" && item.reasonCode !== "reported_score_below_minimum"
      || item.status === "unverified" && ["criteria_met", "criterion_not_met", "reported_score_below_minimum", "repair_target_unresolved"].includes(String(item.reasonCode))) return undefined
    criteria.push({ criterionId: item.criterionId as string, status: item.status as "passed" | "failed" | "unverified", reasonCode: item.reasonCode as TaskGraphVerificationReasonCode })
  }
  const status = value.status as TaskGraphVerificationReport["status"]
  const reasonCode = value.reasonCode as TaskGraphVerificationReasonCode
  const repairUnresolved = status === "unverified" && reasonCode === "repair_target_unresolved" && value.evidenceDigest === null
    && typeof value.resultDigest === "string" && criteria.every(item => item.status === "passed" && item.reasonCode === "criteria_met")
  const coherent = repairUnresolved || (status === "passed" ? reasonCode === "criteria_met" && typeof value.resultDigest === "string" && criteria.every(item => item.status === "passed")
    : status === "failed" ? typeof value.resultDigest === "string" && criteria.some(item => item.status === "failed") && reasonCode === criteria.find(item => item.status === "failed")?.reasonCode && criteria.every(item => item.status !== "unverified")
      : criteria.every(item => item.status === "unverified" && item.reasonCode === reasonCode) && (value.evidenceDigest === null ? value.resultDigest === null : typeof value.resultDigest === "string"))
  if (!coherent) return undefined

  let dependencyBindings: readonly TaskGraphVerificationDependencyBinding[] | undefined
  if (hasBindings) {
    dependencyBindings = parseBindings(value.dependencyBindings)
    if (!dependencyBindings || status === "unverified") return undefined
  }
  if (expectedDependencyNodeKeys !== undefined) {
    const expected = [...expectedDependencyNodeKeys].sort(compareKeys)
    if (expected.length > MAX_BINDINGS || new Set(expected).size !== expected.length || expected.some(key => !boundedId(key))) return undefined
    if (expected.length === 0 && dependencyBindings) return undefined
    if (status === "passed" && expected.length > 0 && (!dependencyBindings || dependencyBindings.map(binding => binding.nodeKey).join("\0") !== expected.join("\0"))) return undefined
    if (status === "failed" && dependencyBindings && dependencyBindings.map(binding => binding.nodeKey).join("\0") !== expected.join("\0")) return undefined
    if (status === "unverified" && dependencyBindings) return undefined
  }
  return {
    verifierVersion: TASK_GRAPH_VERIFIER_VERSION,
    status,
    reasonCode,
    criteria,
    evidenceDigest: value.evidenceDigest as string | null,
    resultDigest: value.resultDigest as string | null,
    ...(dependencyBindings ? { dependencyBindings } : {}),
  }
}

/** Reconstructs the only report shape allowed in public TaskGraph projections. */
export function publicTaskGraphVerificationReport(report: TaskGraphStoredVerificationReport): TaskGraphVerificationReport {
  return {
    verifierVersion: report.verifierVersion,
    status: report.status,
    reasonCode: report.reasonCode,
    criteria: report.criteria.map(item => ({ ...item })),
    evidenceDigest: report.evidenceDigest,
    resultDigest: report.resultDigest,
  }
}
