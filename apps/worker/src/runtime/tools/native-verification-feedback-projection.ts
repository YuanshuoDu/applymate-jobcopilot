import {
  NATIVE_VERIFICATION_REPORT_SCHEMA,
  type NativeVerificationDisposition,
  type NativeVerificationReasonCode,
} from "../subagents/native-verification-contract.js"

const REPORT_KEY = "nativeVerificationReport"
const FEEDBACK_KEY = "nativeVerificationFeedback"
const REPORT_FIELDS = [
  "schemaVersion", "controlOperationId", "controlTaskId", "controlAttempt", "owner", "target",
  "goalDigest", "criteriaDigest", "evidencePacketDigest", "disposition", "criteria",
] as const
const CRITERION_FIELDS = ["criterionId", "disposition", "reasonCode", "evidenceReferenceIds"] as const
const DISPOSITIONS: readonly NativeVerificationDisposition[] = ["passed", "failed", "uncertain"]
const REASONS: readonly NativeVerificationReasonCode[] = [
  "meets_criterion", "does_not_meet_criterion", "evidence_missing", "evidence_conflict", "ambiguous", "unsupported_claim",
]
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const DIGEST = /^[a-f0-9]{64}$/

type CriterionFeedback = Readonly<{
  criterionId: string
  disposition: NativeVerificationDisposition
  reasonCode: NativeVerificationReasonCode
  evidenceReferenceIds: readonly string[]
}>
type NativeVerificationFeedback = Readonly<{
  disposition: NativeVerificationDisposition
  criteria: readonly CriterionFeedback[]
}>

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.getOwnPropertyNames(value).length !== Object.keys(value).length
    || Object.values(descriptors).some(descriptor => !descriptor.enumerable || !("value" in descriptor))) return null
  return value as Record<string, unknown>
}

function exact(value: unknown, fields: readonly string[]): Record<string, unknown> | null {
  const parsed = record(value)
  return parsed && Object.keys(parsed).sort().join("\0") === [...fields].sort().join("\0") ? parsed : null
}

function denseArray(value: unknown, maxLength: number, minLength = 1): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < minLength || value.length > maxLength
    || Object.getOwnPropertySymbols(value).length) return false
  const names = Object.getOwnPropertyNames(value)
  if (names.length !== value.length + 1 || !names.includes("length")) return false
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor?.enumerable || !("value" in descriptor)) return false
  }
  return true
}

function isId(value: unknown): value is string { return typeof value === "string" && ID.test(value) }
function isDigest(value: unknown): value is string { return typeof value === "string" && DIGEST.test(value) }
function isDisposition(value: unknown): value is NativeVerificationDisposition {
  return typeof value === "string" && DISPOSITIONS.includes(value as NativeVerificationDisposition)
}
function isReason(value: unknown): value is NativeVerificationReasonCode {
  return typeof value === "string" && REASONS.includes(value as NativeVerificationReasonCode)
}

function validPrivateBindings(report: Record<string, unknown>): boolean {
  if (!isId(report.controlOperationId) || !isId(report.controlTaskId)
    || !Number.isSafeInteger(report.controlAttempt) || Number(report.controlAttempt) < 1
    || !isDigest(report.goalDigest) || !isDigest(report.criteriaDigest) || !isDigest(report.evidencePacketDigest)) return false
  const owner = exact(report.owner, ["userId", "sessionId", "turnId", "rootTaskId", "parentTaskId"])
  if (!owner || ![owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId].every(isId)
    || !(owner.parentTaskId === null || isId(owner.parentTaskId))) return false
  const target = record(report.target)
  if (!target) return false
  if (target.kind === "root_goal") {
    const root = exact(target, ["kind", "candidateDigest", "childBindingSetDigest"])
    return Boolean(root && isDigest(root.candidateDigest) && isDigest(root.childBindingSetDigest))
  }
  const child = exact(target, ["kind", "nodeId", "nativeOperationId", "fingerprint", "taskId", "attempt", "resultDigest"])
  return Boolean(child && child.kind === "child" && isId(child.nodeId) && isId(child.nativeOperationId)
    && isDigest(child.fingerprint) && isId(child.taskId) && Number.isSafeInteger(child.attempt)
    && Number(child.attempt) > 0 && isDigest(child.resultDigest))
}

function feedback(reportValue: unknown): NativeVerificationFeedback | null {
  const report = exact(reportValue, REPORT_FIELDS)
  if (!report || report.schemaVersion !== NATIVE_VERIFICATION_REPORT_SCHEMA || !validPrivateBindings(report)
    || !isDisposition(report.disposition) || !denseArray(report.criteria, 32)) return null

  const criteria: CriterionFeedback[] = []
  for (const [index, value] of report.criteria.entries()) {
    const item = exact(value, CRITERION_FIELDS)
    if (!item || item.criterionId !== `criterion-${index + 1}` || !isDisposition(item.disposition) || !isReason(item.reasonCode)
      || !denseArray(item.evidenceReferenceIds, 8, 0)) return null
    const references: string[] = []
    for (const reference of item.evidenceReferenceIds) {
      if (!isId(reference) || references.includes(reference)) return null
      references.push(reference)
    }
    if (item.disposition === "passed" && (item.reasonCode !== "meets_criterion" || references.length === 0)) return null
    if (item.disposition === "failed" && !["does_not_meet_criterion", "evidence_conflict", "unsupported_claim"].includes(item.reasonCode)) return null
    if (item.disposition === "uncertain" && !["evidence_missing", "evidence_conflict", "ambiguous", "unsupported_claim"].includes(item.reasonCode)) return null
    criteria.push({ criterionId: item.criterionId, disposition: item.disposition, reasonCode: item.reasonCode, evidenceReferenceIds: references })
  }
  const expectedDisposition = criteria.some(item => item.disposition === "failed") ? "failed"
    : criteria.some(item => item.disposition === "uncertain") ? "uncertain" : "passed"
  return expectedDisposition === report.disposition ? { disposition: report.disposition, criteria } : null
}

/** Replaces the server-only proof receipt with bounded, non-authoritative model feedback. */
export function projectNativeVerificationResult(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  let reportDescriptor: PropertyDescriptor | undefined
  try { reportDescriptor = Object.getOwnPropertyDescriptor(value, REPORT_KEY) } catch { return null }
  if (!reportDescriptor) return value

  const projected: Record<string, unknown> = {}
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || key === REPORT_KEY || key === FEEDBACK_KEY) continue
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor?.enumerable && "value" in descriptor) projected[key] = descriptor.value
    }
    if (reportDescriptor.enumerable && "value" in reportDescriptor) {
      const safeFeedback = feedback(reportDescriptor.value)
      if (safeFeedback) projected[FEEDBACK_KEY] = safeFeedback
    }
    return projected
  } catch { return null }
}
