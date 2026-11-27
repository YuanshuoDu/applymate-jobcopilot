import type { TaskGraphSnapshotNode } from "./plan-ledger.js"
import { isSelectedJobBatchTemplateId } from "./selected-job-batch-templates.js"
import { isStrictNativeTaskGraphNode } from "./plan-ledger-native-metadata.js"
const BASE_KEYS = "dependsOn,depth,goal,key,successCriteria,taskId,templateId"
const DISPOSITION_KEYS = BASE_KEYS + ",verificationDisposition"
const VERIFICATION_KEYS = BASE_KEYS + ",verification,verificationDisposition"
const REPAIR_KEYS = "dependsOn,depth,goal,key,repairOf,successCriteria,taskId,templateId,verification,verificationDisposition"
const VERIFICATION_VERSION = "agent-harness.v2.task-graph-verification.v1"
const VERIFIER_VERSION = "agent-harness.v2.task-graph-verifier.v1"
const RECEIPT_VERSION = "agent-harness.v2.task-graph-repair-receipt.v1"
const ROLE_RESULT_SCHEMA = "agent-harness.v2.subagent.result"
const CRITERION_ID = /^[a-z][a-z0-9._-]{0,63}$/
const DIGEST = /^[a-f0-9]{64}$/
const REPORT_REASONS = new Set([
  "criteria_met", "criterion_not_met", "reported_score_below_minimum", "contract_invalid", "projection_invalid",
  "role_mismatch", "canonical_evidence_missing", "canonical_evidence_invalid", "canonical_evidence_ambiguous",
  "result_invalid", "result_ambiguous", "result_evidence_unbound", "repair_target_unresolved",
])
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
function exactNodeKeys(value: Record<string, unknown>, keys: string): boolean {
  return exact(value, keys) || Object.hasOwn(value, "registeredScoutEnvelope")
    && Reflect.ownKeys(value).filter(key => key !== "registeredScoutEnvelope").sort().join(",") === keys
}
function dense(value: unknown, min: number, max: number): value is unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) return false
  return Array.from({ length: value.length }, (_, index) => String(index)).every(key => Object.hasOwn(value, key))
}
function unionSelectorList(value: unknown): string[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>, length = descriptors.length?.value
    if (!Number.isSafeInteger(length) || Number(length) < 2 || Number(length) > 8 || Reflect.ownKeys(value).length !== Number(length) + 1) return null
    const selectors: string[] = []
    for (let index = 0; index < Number(length); index++) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true || !boundedId(descriptor.value)) return null
      selectors.push(descriptor.value)
    }
    return new Set(selectors).size === selectors.length ? selectors : null
  } catch { return null }
}
function unionSelectors(value: unknown): string[] | null | undefined {
  if (!record(value)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, "kind")
  const kind = descriptor && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : undefined
  if (kind !== "findings_from_scout_union" && kind !== "findings_cover_scout_candidate_union_gte"
    && kind !== "findings_cover_each_scout_candidates_gte") return undefined
  const row = strictObject(value, kind === "findings_from_scout_union" ? "dependencyNodeKeys,kind" : "dependencyNodeKeys,kind,minimumPercent")
  if (!row) return null
  const selectors = unionSelectorList(row.dependencyNodeKeys)
  return selectors && (kind === "findings_from_scout_union"
    || Number.isSafeInteger(row.minimumPercent) && Number(row.minimumPercent) >= 1 && Number(row.minimumPercent) <= 100) ? selectors : null
}
function boundedId(value: unknown, max = 128): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max
}
function stableIds(value: unknown, minimum: number, maximum: number): value is string[] {
  return dense(value, minimum, maximum) && value.every(id => typeof id === "string" && CRITERION_ID.test(id))
    && new Set(value).size === value.length
}
function check(value: unknown, role: "scout" | "analyst"): boolean {
  if (!record(value)) return false
  const kindDescriptor = Object.getOwnPropertyDescriptor(value, "kind")
  if (!kindDescriptor || !("value" in kindDescriptor) || typeof kindDescriptor.value !== "string") return false
  const kind = kindDescriptor.value
  const union = unionSelectors(value)
  if (union !== undefined) return role === "analyst" && union !== null
  if (kind === "candidate_count_gte" && role === "scout" || kind === "finding_count_gte" && role === "analyst"
    || kind === "evidence_count_gte") {
    return exact(value, "kind,minimum") && positive(value.minimum)
  }
  if (kind === "all_candidates_have_evidence" && role === "scout" || kind === "all_findings_have_evidence" && role === "analyst") {
    return exact(value, "kind,minimumItems") && positive(value.minimumItems)
  }
  if (kind === "findings_from_scout_dependency" && role === "analyst") {
    return exact(value, "dependencyNodeKey,kind") && boundedId(value.dependencyNodeKey)
  }
  if (kind === "findings_cover_scout_candidates_gte" && role === "analyst") {
    return exact(value, "dependencyNodeKey,kind,minimumPercent") && boundedId(value.dependencyNodeKey)
      && Number.isSafeInteger(value.minimumPercent) && Number(value.minimumPercent) >= 1 && Number(value.minimumPercent) <= 100
  }
  return kind === "reported_score_gte" && role === "analyst" && exact(value, "aggregation,kind,minimumFindings,minimumScore")
    && positive(value.minimumFindings) && typeof value.minimumScore === "number" && Number.isFinite(value.minimumScore)
    && value.minimumScore >= 0 && value.minimumScore <= 10 && (value.aggregation === "any" || value.aggregation === "all")
}
function strictObject(value: unknown, keys: string): Record<string, unknown> | null {
  try {
    if (!record(value) || !exact(value, keys)) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    return keys.split(",").every(key => {
      const descriptor = descriptors[key]
      return Boolean(descriptor && "value" in descriptor && descriptor.enumerable === true)
    }) ? value : null
  } catch { return null }
}
export function readPersistedTaskGraphVerificationSelectors(value: unknown): { role: "scout" | "analyst"; dependencyNodeKeys: readonly string[] } | null | undefined {
  try {
    const template = record(value) && Object.getOwnPropertyDescriptor(value, "templateId")
    if (!template) return undefined
    if (!("value" in template)) return null
    if (template.value !== "scout" && template.value !== "analyst") return undefined
    const templateRole = template.value as "scout" | "analyst"
    const rawVerification = Object.getOwnPropertyDescriptor(value, "verification")
    if (!rawVerification) return undefined
    const verification = strictObject("value" in rawVerification ? rawVerification.value : null, "criteria,role,schemaVersion")
    if (!verification || verification.role !== templateRole || verification.schemaVersion !== VERIFICATION_VERSION) return null
    if (!Array.isArray(verification.criteria) || verification.criteria.length < 1 || verification.criteria.length > 8
      || Reflect.ownKeys(verification.criteria).length !== verification.criteria.length + 1) return null
    const selectors: string[] = []
    for (let index = 0; index < verification.criteria.length; index++) {
      const criterionDescriptor = Object.getOwnPropertyDescriptor(verification.criteria, String(index))
      if (!criterionDescriptor || !("value" in criterionDescriptor) || criterionDescriptor.enumerable !== true) return null
      const criterionRow = strictObject(criterionDescriptor.value, "check,id")
      if (!criterionRow) return null
      const union = unionSelectors(criterionRow.check)
      if (union === null) return null
      if (union) selectors.push(...union)
    }
    const disposition = Object.getOwnPropertyDescriptor(value, "verificationDisposition")
    if (!disposition || !("value" in disposition) || disposition.value !== "typed") return selectors.length ? null : undefined
    return { role: verification.role as "scout" | "analyst", dependencyNodeKeys: selectors }
  } catch { return null }
}
function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 50
}

function verification(value: unknown, templateId: unknown): boolean {
  const role = templateId === "scout" ? "scout" : templateId === "analyst" ? "analyst" : null
  if (!role || !record(value) || !exact(value, "criteria,role,schemaVersion")
    || value.schemaVersion !== VERIFICATION_VERSION || value.role !== role || !dense(value.criteria, 1, 8)) return false
  const ids = new Set<string>()
  return value.criteria.every(item => {
    if (!record(item) || !exact(item, "check,id") || typeof item.id !== "string" || !CRITERION_ID.test(item.id) || ids.has(item.id)
      || !check(item.check, role)) return false
    ids.add(item.id)
    return true
  })
}

function registeredScoutEnvelope(value: unknown, templateId: unknown, disposition: unknown): boolean {
  if (templateId !== "scout" || disposition !== "typed" || !record(value)
    || !exact(value, "allowedActions,expectedOutputSchema,role,taskType") || value.role !== "scout" || !boundedId(value.taskType)
    || !record(value.expectedOutputSchema) || !exact(value.expectedOutputSchema, "role,schemaVersion")
    || value.expectedOutputSchema.schemaVersion !== ROLE_RESULT_SCHEMA || value.expectedOutputSchema.role !== "scout"
    || !dense(value.allowedActions, 0, 32)) return false
  return value.allowedActions.every(action => typeof action === "string" && action.trim().length > 0 && action.length <= 128)
}

function repairOf(value: unknown): boolean {
  if (!record(value) || !exact(value, "criterionIds,graphRootTaskId,nodeKey,taskId")
    || !boundedId(value.graphRootTaskId) || !boundedId(value.nodeKey) || !boundedId(value.taskId)
    || !stableIds(value.criterionIds, 1, 8)) return false
  return value.criterionIds.every(id => id.length <= 64)
}

/** Structural-only parser for persisted V2 nodes; metadata is removed from the public projection. */
export function parsePersistedTaskGraphNode(value: unknown): TaskGraphSnapshotNode | null {
  try {
    if (!record(value)) return null
    const nativeDeclared = Object.hasOwn(value, "nativeDelegation") || value.templateId === "native"
    const native = isStrictNativeTaskGraphNode(value)
    if (nativeDeclared && !native) return null
    if (Object.hasOwn(value, "registeredScoutEnvelope")
      && !registeredScoutEnvelope(value.registeredScoutEnvelope, value.templateId, value.verificationDisposition)) return null
    const shape = native ? "native"
      : exactNodeKeys(value, BASE_KEYS) ? "base"
      : exactNodeKeys(value, DISPOSITION_KEYS) ? "disposition"
        : exactNodeKeys(value, VERIFICATION_KEYS) ? "verification"
          : exactNodeKeys(value, REPAIR_KEYS) ? "repair" : null
    if (!shape) return null
    const hasVerification = Object.hasOwn(value, "verification")
    const disposition = shape === "base" ? (hasVerification ? "typed" : "legacy_unverified") : value.verificationDisposition
    if (disposition !== "typed" && disposition !== "legacy_unverified" && disposition !== "specialized") return null
    if (disposition === "typed" ? !hasVerification || !verification(value.verification, value.templateId) : hasVerification) return null
    if (disposition === "specialized" && value.templateId !== "cover_letter_writer" && value.templateId !== "cover_letter_reviewer"
      && !isSelectedJobBatchTemplateId(value.templateId)) return null
    if (shape === "repair" && (disposition !== "typed" || !repairOf(value.repairOf))) return null
    return {
      key: value.key as string, templateId: value.templateId as string, goal: value.goal as string,
      successCriteria: value.successCriteria as string[], dependsOn: value.dependsOn as string[],
      depth: value.depth as number, taskId: value.taskId as string,
    }
  } catch { return null }
}

function report(value: unknown): value is Record<string, unknown> {
  if (!record(value)) return false
  const hasBindings = Object.hasOwn(value, "dependencyBindings")
  if (!exact(value, hasBindings
    ? "criteria,dependencyBindings,evidenceDigest,reasonCode,resultDigest,status,verifierVersion"
    : "criteria,evidenceDigest,reasonCode,resultDigest,status,verifierVersion")
    || value.verifierVersion !== VERIFIER_VERSION || typeof value.reasonCode !== "string" || !REPORT_REASONS.has(value.reasonCode)
    || typeof value.status !== "string" || !["passed", "failed", "unverified"].includes(value.status)
    || !(value.evidenceDigest === null || typeof value.evidenceDigest === "string" && DIGEST.test(value.evidenceDigest))
    || !(value.resultDigest === null || typeof value.resultDigest === "string" && DIGEST.test(value.resultDigest))
    || !dense(value.criteria, 0, 8)) return false
  const ids = new Set<string>()
  for (const item of value.criteria) {
    if (!record(item) || !exact(item, "criterionId,reasonCode,status") || typeof item.criterionId !== "string"
      || !CRITERION_ID.test(item.criterionId) || ids.has(item.criterionId) || typeof item.reasonCode !== "string"
      || !REPORT_REASONS.has(item.reasonCode) || typeof item.status !== "string"
      || !["passed", "failed", "unverified"].includes(item.status)) return false
    ids.add(item.criterionId)
  }
  if (hasBindings) {
    if (value.status === "unverified" || !dense(value.dependencyBindings, 1, 8)) return false
    let previous: string | undefined
    for (const item of value.dependencyBindings) {
      if (!record(item) || !exact(item, "attemptCount,evidenceDigest,nodeDigest,nodeKey,reportDigest,resultDigest,taskId")
        || !boundedId(item.nodeKey) || !boundedId(item.taskId) || !Number.isSafeInteger(item.attemptCount) || Number(item.attemptCount) < 1
        || ![item.nodeDigest, item.resultDigest, item.evidenceDigest, item.reportDigest].every(digest => typeof digest === "string" && DIGEST.test(digest))
        || previous !== undefined && previous >= item.nodeKey) return false
      previous = item.nodeKey
    }
  }
  return value.criteria.length > 0 || value.status === "unverified" && value.reasonCode === "contract_invalid"
    && value.evidenceDigest === null && value.resultDigest === null
}

function receipt(value: unknown): boolean {
  if (!record(value) || !exact(value, "criterionIds,evidenceDigest,graphRootTaskId,repairNodeKey,repairTaskId,schemaVersion,targetNodeKey,targetTaskId,verifierVersion")
    || value.schemaVersion !== RECEIPT_VERSION || value.verifierVersion !== VERIFIER_VERSION
    || ![value.graphRootTaskId, value.targetNodeKey, value.targetTaskId, value.repairNodeKey, value.repairTaskId].every(item => boundedId(item))
    || !stableIds(value.criterionIds, 1, 8) || value.criterionIds.some(id => id.length > 64)
    || typeof value.evidenceDigest !== "string" || !DIGEST.test(value.evidenceDigest)) return false
  return true
}

/** Allows only recognized Worker result metadata; it is never used as preview or status evidence. */
export function validTaskGraphResultEnvelopeKeys(value: Record<string, unknown>): boolean {
  try {
    const hasReport = Object.hasOwn(value, "taskGraphVerificationReport")
    const hasReceipt = Object.hasOwn(value, "taskGraphRepairReceipt")
    const keys = ["finalItemId", "finalText", "status", "stepCount", "structuredResult", "toolCallCount",
      ...(hasReport ? ["taskGraphVerificationReport"] : []), ...(hasReceipt ? ["taskGraphRepairReceipt"] : [])].sort().join(",")
    if (!exact(value, keys) || hasReceipt && !hasReport) return false
    if (hasReport && !report(value.taskGraphVerificationReport)) return false
    return !hasReceipt || receipt(value.taskGraphRepairReceipt)
  } catch { return false }
}
