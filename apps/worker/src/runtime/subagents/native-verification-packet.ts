import { Buffer } from "node:buffer"
import {
  NATIVE_VERIFICATION_PACKET_CONTEXT_KEY, NATIVE_VERIFICATION_PACKET_SCHEMA,
  canonicalNativeVerificationJson, digestNativeVerificationValue,
  isNativeVerificationJsonArray,
  parseNativeVerificationControl,
  type NativeVerificationControl, type NativeVerificationEvidence, type NativeVerificationPacket,
} from "./native-verification-contract.js"

const MAX_PACKET_BYTES = 32 * 1024
const MAX_GOAL_BYTES = 4 * 1024
const MAX_TARGET_BYTES = 16 * 1024
const MAX_CRITERIA = 32
const MAX_EVIDENCE = 32
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

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

function text(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes
}

function parseCriteria(value: unknown): NativeVerificationPacket["criteria"] | null {
  if (!isNativeVerificationJsonArray(value, MAX_CRITERIA) || value.length < 1) return null
  const criteria = value.map((item, index) => {
    const row = exact(item, ["criterionId", "requirement"])
    if (!row || row.criterionId !== `criterion-${index + 1}` || !text(row.requirement, 2_000)) return null
    return { criterionId: row.criterionId, requirement: row.requirement }
  })
  return criteria.every(Boolean) ? criteria as NonNullable<ReturnType<typeof parseCriteria>> : null
}

function parseTarget(value: unknown, control: NativeVerificationControl): NativeVerificationPacket["target"] | null {
  const row = record(value)
  if (!row) return null
  if (control.target.kind === "child") {
    const target = exact(row, ["kind", "taskId", "attempt", "resultDigest", "referenceId", "resultText"])
    if (!target || target.kind !== "child" || target.taskId !== control.target.taskId || target.attempt !== control.target.attempt
      || target.resultDigest !== control.target.resultDigest || typeof target.referenceId !== "string" || !ID.test(target.referenceId) || !text(target.resultText, MAX_TARGET_BYTES)) return null
    try {
      const result = JSON.parse(target.resultText) as unknown
      if (canonicalNativeVerificationJson(result) !== target.resultText || digestNativeVerificationValue(result) !== control.target.resultDigest) return null
    } catch { return null }
    return target as NativeVerificationPacket["target"]
  }
  const target = exact(row, ["kind", "candidateDigest", "referenceId", "candidateText"])
  if (!target || target.kind !== "root_goal" || target.candidateDigest !== control.target.candidateDigest
    || typeof target.referenceId !== "string" || !ID.test(target.referenceId) || !text(target.candidateText, MAX_TARGET_BYTES)
    || digestNativeVerificationValue(target.candidateText) !== control.target.candidateDigest) return null
  return target as NativeVerificationPacket["target"]
}

function parseEvidence(value: unknown, targetReferenceId: string): readonly NativeVerificationEvidence[] | null {
  if (!isNativeVerificationJsonArray(value, MAX_EVIDENCE)) return null
  const seen = new Set<string>([targetReferenceId])
  const evidence = value.map(item => {
    const row = exact(item, ["referenceId", "kind", "summary"])
    if (!row || typeof row.referenceId !== "string" || !ID.test(row.referenceId) || seen.has(row.referenceId)
      || typeof row.kind !== "string" || !/^[a-z][a-z0-9_]{0,39}$/.test(row.kind) || !text(row.summary, 1_000)) return null
    seen.add(row.referenceId)
    return { referenceId: row.referenceId, kind: row.kind, summary: row.summary }
  })
  return evidence.every(Boolean) ? evidence as NativeVerificationEvidence[] : null
}

/** Context is deliberately a single server-owned packet field; ordinary task context is excluded. */
export function parseNativeVerificationPacket(value: unknown, rawControl: NativeVerificationControl): NativeVerificationPacket | null {
  const control = parseNativeVerificationControl(rawControl)
  const context = exact(value, [NATIVE_VERIFICATION_PACKET_CONTEXT_KEY])
  if (!control || !context) return null
  const packet = exact(context[NATIVE_VERIFICATION_PACKET_CONTEXT_KEY], ["schemaVersion", "controlOperationId", "controlTaskId", "goal", "criteria", "target", "evidence"])
  if (!packet || packet.schemaVersion !== NATIVE_VERIFICATION_PACKET_SCHEMA || packet.controlOperationId !== control.controlOperationId
    || packet.controlTaskId !== control.controlTaskId || !text(packet.goal, MAX_GOAL_BYTES)) return null
  const criteria = parseCriteria(packet.criteria)
  const target = parseTarget(packet.target, control)
  if (!criteria || !target) return null
  const evidence = parseEvidence(packet.evidence, target.referenceId)
  if (!evidence) return null
  const parsed: NativeVerificationPacket = {
    schemaVersion: NATIVE_VERIFICATION_PACKET_SCHEMA,
    controlOperationId: control.controlOperationId,
    controlTaskId: control.controlTaskId,
    goal: packet.goal,
    criteria,
    target,
    evidence,
  }
  try {
    if (digestNativeVerificationValue(parsed.goal) !== control.goalDigest
      || digestNativeVerificationValue(parsed.criteria) !== control.criteriaDigest
      || digestNativeVerificationValue(parsed) !== control.evidencePacketDigest
      || Buffer.byteLength(canonicalNativeVerificationJson(parsed), "utf8") > MAX_PACKET_BYTES) return null
  } catch { return null }
  return parsed
}

export function createNativeVerificationContext(packet: NativeVerificationPacket): { readonly nativeVerificationPacket: NativeVerificationPacket } {
  return { [NATIVE_VERIFICATION_PACKET_CONTEXT_KEY]: packet }
}
