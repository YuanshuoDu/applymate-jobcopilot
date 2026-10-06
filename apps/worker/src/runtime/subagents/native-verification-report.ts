import { Buffer } from "node:buffer"
import {
  NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA, NATIVE_VERIFICATION_REPORT_SCHEMA,
  canonicalNativeVerificationJson, isNativeVerificationJsonArray, parseNativeVerificationControl,
  type NativeVerificationControl, type NativeVerificationCriterionVerdict,
  type NativeVerificationDisposition, type NativeVerificationModelReport, type NativeVerificationPacket,
  type NativeVerificationReasonCode, type NativeVerificationReport,
} from "./native-verification-contract.js"
import { createNativeVerificationContext, parseNativeVerificationPacket } from "./native-verification-packet.js"

const MAX_MODEL_REPORT_BYTES = 32 * 1024
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const REASONS: readonly NativeVerificationReasonCode[] = [
  "meets_criterion", "does_not_meet_criterion", "evidence_missing", "evidence_conflict", "ambiguous", "unsupported_claim",
]
const DISPOSITIONS: readonly NativeVerificationDisposition[] = ["passed", "failed", "uncertain"]

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.getOwnPropertyNames(value).length !== Object.keys(value).length
    || Object.values(descriptors).some(descriptor => !descriptor.enumerable || !("value" in descriptor))) return null
  return value as Record<string, unknown>
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const parsed = record(value)
  return parsed && Object.keys(parsed).sort().join("\0") === [...keys].sort().join("\0") ? parsed : null
}

function reportInput(value: unknown): unknown | null {
  if (typeof value !== "string") return value
  if (Buffer.byteLength(value, "utf8") > MAX_MODEL_REPORT_BYTES) return null
  try { return JSON.parse(value) as unknown } catch { return null }
}

function targetReference(packet: NativeVerificationPacket): string {
  return packet.target.referenceId
}

export function parseNativeVerificationModelReport(value: unknown, packet: NativeVerificationPacket): NativeVerificationModelReport | null {
  const raw = reportInput(value)
  const root = exact(raw, ["schemaVersion", "criteria"])
  if (!root || root.schemaVersion !== NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA
  || !isNativeVerificationJsonArray(root.criteria, 32) || root.criteria.length !== packet.criteria.length) return null
  const allowedReferences = new Set([targetReference(packet), ...packet.evidence.map(item => item.referenceId)])
  const criteria: NativeVerificationCriterionVerdict[] = []
  for (const [index, rawVerdict] of root.criteria.entries()) {
    const verdict = exact(rawVerdict, ["criterionId", "disposition", "reasonCode", "evidenceReferenceIds"])
    const expected = packet.criteria[index]
    if (!verdict || !expected || verdict.criterionId !== expected.criterionId
      || !DISPOSITIONS.includes(verdict.disposition as NativeVerificationDisposition)
      || !REASONS.includes(verdict.reasonCode as NativeVerificationReasonCode)
      || !isNativeVerificationJsonArray(verdict.evidenceReferenceIds, 8)) return null
    const references: string[] = []
    const seen = new Set<string>()
    for (const reference of verdict.evidenceReferenceIds) {
      if (typeof reference !== "string" || !ID.test(reference) || !allowedReferences.has(reference) || seen.has(reference)) return null
      seen.add(reference)
      references.push(reference)
    }
    const disposition = verdict.disposition as NativeVerificationDisposition
    const reasonCode = verdict.reasonCode as NativeVerificationReasonCode
    if (disposition === "passed" && (reasonCode !== "meets_criterion" || references.length === 0)) return null
    if (disposition === "failed" && !["does_not_meet_criterion", "evidence_conflict", "unsupported_claim"].includes(reasonCode)) return null
    if (disposition === "uncertain" && !["evidence_missing", "evidence_conflict", "ambiguous", "unsupported_claim"].includes(reasonCode)) return null
    criteria.push({ criterionId: expected.criterionId, disposition, reasonCode, evidenceReferenceIds: references })
  }
  return { schemaVersion: NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA, criteria }
}

export function attachNativeVerificationReport(
  rawControl: NativeVerificationControl,
  controlAttempt: number,
  modelReport: NativeVerificationModelReport,
): NativeVerificationReport | null {
  const control = parseNativeVerificationControl(rawControl)
  if (!control || !Number.isSafeInteger(controlAttempt) || controlAttempt < 1) return null
  let disposition: NativeVerificationDisposition = "passed"
  if (modelReport.criteria.some(item => item.disposition === "failed")) disposition = "failed"
  else if (modelReport.criteria.some(item => item.disposition === "uncertain")) disposition = "uncertain"
  return {
    schemaVersion: NATIVE_VERIFICATION_REPORT_SCHEMA,
    controlOperationId: control.controlOperationId,
    controlTaskId: control.controlTaskId,
    controlAttempt,
    owner: control.owner,
    target: control.target,
    goalDigest: control.goalDigest,
    criteriaDigest: control.criteriaDigest,
    evidencePacketDigest: control.evidencePacketDigest,
    disposition,
    criteria: modelReport.criteria.map(item => ({
      criterionId: item.criterionId, disposition: item.disposition, reasonCode: item.reasonCode,
      evidenceReferenceIds: [...item.evidenceReferenceIds],
    })),
  }
}

/** Validates persisted proof against the current marker, packet and durable attempt. */
export function parseNativeVerificationReport(
  value: unknown,
  rawControl: NativeVerificationControl,
  packet: NativeVerificationPacket,
  currentControlAttempt: number,
): NativeVerificationReport | null {
  const report = exact(value, [
    "schemaVersion", "controlOperationId", "controlTaskId", "controlAttempt", "owner", "target",
    "goalDigest", "criteriaDigest", "evidencePacketDigest", "disposition", "criteria",
  ])
  const control = parseNativeVerificationControl(rawControl)
  if (!report || !control || report.schemaVersion !== NATIVE_VERIFICATION_REPORT_SCHEMA) return null
  const validatedPacket = parseNativeVerificationPacket(createNativeVerificationContext(packet), control)
  if (!validatedPacket) return null
  const parsedModelReport = parseNativeVerificationModelReport({ schemaVersion: NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA, criteria: report.criteria }, validatedPacket)
  if (!parsedModelReport) return null
  const expected = attachNativeVerificationReport(control, currentControlAttempt, parsedModelReport)
  if (!expected) return null
  try {
    return canonicalNativeVerificationJson(report) === canonicalNativeVerificationJson(expected) ? expected : null
  } catch { return null }
}
