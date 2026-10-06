import { createHash } from "node:crypto"
import { Buffer } from "node:buffer"

export const NATIVE_VERIFICATION_CONTROL_SCHEMA = "agent-harness.v2.native-verifier-control.v1" as const
export const NATIVE_VERIFICATION_PACKET_SCHEMA = "agent-harness.v2.native-verifier-packet.v1" as const
export const NATIVE_VERIFICATION_PACKET_SCHEMA_V2 = "agent-harness.v2.native-verifier-packet.v2" as const
export const NATIVE_VERIFICATION_PACKET_V2_MAX_BYTES = 256 * 1024
export const NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND = "user_self_attestation" as const
export const NATIVE_VERIFICATION_USER_SELF_ATTESTATION_REFERENCE_PREFIX = "user-self-attestation:" as const
export const NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA = "agent-harness.v2.native-verifier-model-report.v1" as const
export const NATIVE_VERIFICATION_REPORT_SCHEMA = "agent-harness.v2.native-verifier-report.v1" as const
export const NATIVE_VERIFICATION_PACKET_CONTEXT_KEY = "nativeVerificationPacket" as const

export type NativeVerificationTargetBinding =
  | { readonly kind: "child"; readonly nodeId: string; readonly nativeOperationId: string; readonly fingerprint: string; readonly taskId: string; readonly attempt: number; readonly resultDigest: string }
  | { readonly kind: "root_goal"; readonly candidateDigest: string; readonly childBindingSetDigest: string }

export type NativeVerificationOwnerBinding = {
  readonly userId: string
  readonly sessionId: string
  readonly turnId: string
  readonly rootTaskId: string
  readonly parentTaskId: string | null
}

export type NativeVerificationControl = {
  readonly schemaVersion: typeof NATIVE_VERIFICATION_CONTROL_SCHEMA
  readonly controlOperationId: string
  readonly controlTaskId: string
  readonly owner: NativeVerificationOwnerBinding
  readonly target: NativeVerificationTargetBinding
  readonly goalDigest: string
  readonly criteriaDigest: string
  readonly evidencePacketDigest: string
}

export type NativeVerificationCriterion = { readonly criterionId: string; readonly requirement: string }
export type NativeVerificationEvidence = { readonly referenceId: string; readonly kind: string; readonly summary: string }
export type NativeVerificationPacketTarget =
  | { readonly kind: "child"; readonly taskId: string; readonly attempt: number; readonly resultDigest: string; readonly referenceId: string; readonly resultText: string }
  | { readonly kind: "root_goal"; readonly candidateDigest: string; readonly referenceId: string; readonly candidateText: string }
export type NativeVerificationPacket = {
  readonly schemaVersion: typeof NATIVE_VERIFICATION_PACKET_SCHEMA | typeof NATIVE_VERIFICATION_PACKET_SCHEMA_V2
  readonly controlOperationId: string
  readonly controlTaskId: string
  readonly goal: string
  readonly criteria: readonly NativeVerificationCriterion[]
  readonly target: NativeVerificationPacketTarget
  readonly evidence: readonly NativeVerificationEvidence[]
}

export type NativeVerificationDisposition = "passed" | "failed" | "uncertain"
export type NativeVerificationReasonCode = "meets_criterion" | "does_not_meet_criterion" | "evidence_missing" | "evidence_conflict" | "ambiguous" | "unsupported_claim"
export type NativeVerificationCriterionVerdict = {
  readonly criterionId: string
  readonly disposition: NativeVerificationDisposition
  readonly reasonCode: NativeVerificationReasonCode
  readonly evidenceReferenceIds: readonly string[]
}
export type NativeVerificationModelReport = {
  readonly schemaVersion: typeof NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA
  readonly criteria: readonly NativeVerificationCriterionVerdict[]
}
export type NativeVerificationReport = {
  readonly schemaVersion: typeof NATIVE_VERIFICATION_REPORT_SCHEMA
  readonly controlOperationId: string
  readonly controlTaskId: string
  readonly controlAttempt: number
  readonly owner: NativeVerificationOwnerBinding
  readonly target: NativeVerificationTargetBinding
  readonly goalDigest: string
  readonly criteriaDigest: string
  readonly evidencePacketDigest: string
  readonly disposition: NativeVerificationDisposition
  readonly criteria: readonly NativeVerificationCriterionVerdict[]
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const DIGEST = /^[a-f0-9]{64}$/
const MAX_CANONICAL_BYTES = NATIVE_VERIFICATION_PACKET_V2_MAX_BYTES
const MAX_CANONICAL_NODES = 10_000
const MAX_CANONICAL_DEPTH = 64

function row(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.getOwnPropertyNames(value).length !== Object.keys(value).length
    || Object.values(descriptors).some(descriptor => !descriptor.enumerable || !("value" in descriptor))) return null
  return value as Record<string, unknown>
}

export function isNativeVerificationJsonArray(value: unknown, maxLength = MAX_CANONICAL_NODES): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maxLength
    || Object.getOwnPropertySymbols(value).length) return false
  const names = Object.getOwnPropertyNames(value)
  if (names.length !== value.length + 1 || !names.includes("length")) return false
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return false
  }
  return true
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const parsed = row(value)
  return parsed && Object.keys(parsed).sort().join("\0") === [...keys].sort().join("\0") ? parsed : null
}

function id(value: unknown): value is string { return typeof value === "string" && ID.test(value) }
function digest(value: unknown): value is string { return typeof value === "string" && DIGEST.test(value) }
export function isNativeVerificationUserSelfAttestationReference(value: unknown): value is string {
  return typeof value === "string" && /^user-self-attestation:[a-f0-9]{64}$/.test(value)
}
function attempt(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }

function parseTarget(value: unknown): NativeVerificationTargetBinding | null {
  const target = row(value)
  if (!target) return null
  if (target.kind === "child") {
    const parsed = exact(target, ["kind", "nodeId", "nativeOperationId", "fingerprint", "taskId", "attempt", "resultDigest"])
    if (!parsed || !id(parsed.nodeId) || !id(parsed.nativeOperationId) || !digest(parsed.fingerprint)
      || !id(parsed.taskId) || !attempt(parsed.attempt) || !digest(parsed.resultDigest)) return null
    return parsed as NativeVerificationTargetBinding
  }
  if (target.kind === "root_goal") {
    const parsed = exact(target, ["kind", "candidateDigest", "childBindingSetDigest"])
    if (!parsed || !digest(parsed.candidateDigest) || !digest(parsed.childBindingSetDigest)) return null
    return parsed as NativeVerificationTargetBinding
  }
  return null
}

export function parseNativeVerificationControl(value: unknown): NativeVerificationControl | null {
  const marker = exact(value, ["schemaVersion", "controlOperationId", "controlTaskId", "owner", "target", "goalDigest", "criteriaDigest", "evidencePacketDigest"])
  if (!marker || marker.schemaVersion !== NATIVE_VERIFICATION_CONTROL_SCHEMA || !id(marker.controlOperationId) || !id(marker.controlTaskId)
    || !digest(marker.goalDigest) || !digest(marker.criteriaDigest) || !digest(marker.evidencePacketDigest)) return null
  const owner = exact(marker.owner, ["userId", "sessionId", "turnId", "rootTaskId", "parentTaskId"])
  if (!owner || ![owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId].every(id) || !(owner.parentTaskId === null || id(owner.parentTaskId))) return null
  const target = parseTarget(marker.target)
  if (!target) return null
  return { ...marker, owner: owner as NativeVerificationOwnerBinding, target } as NativeVerificationControl
}

export function nativeVerificationControlMatchesTask(control: NativeVerificationControl, task: {
  readonly id: string; readonly userId: string; readonly sessionId: string; readonly turnId: string | null
  readonly rootTaskId: string; readonly parentTaskId: string | null; readonly role: string
}): boolean {
  return task.role === "auditor" && control.controlTaskId === task.id
    && control.owner.userId === task.userId && control.owner.sessionId === task.sessionId
    && control.owner.turnId === task.turnId && control.owner.rootTaskId === task.rootTaskId
    && control.owner.parentTaskId === task.parentTaskId
}

export function canonicalNativeVerificationJson(value: unknown): string {
  const seen = new Set<object>()
  let nodes = 0
  let sourceBytes = 0
  const account = (size: number): void => {
    sourceBytes += size
    if (sourceBytes > MAX_CANONICAL_BYTES) throw new TypeError("native_verification_value_too_large")
  }
  const visit = (entry: unknown, depth: number): unknown => {
    nodes += 1
    if (nodes > MAX_CANONICAL_NODES || depth > MAX_CANONICAL_DEPTH) throw new TypeError("native_verification_value_too_complex")
    if (entry === null || typeof entry === "boolean") { account(8); return entry }
    if (typeof entry === "string") { account(Buffer.byteLength(entry, "utf8")); return entry }
    if (typeof entry === "number" && Number.isFinite(entry)) { account(24); return entry }
    if (Array.isArray(entry)) {
      if (!isNativeVerificationJsonArray(entry)) throw new TypeError("native_verification_value_invalid_array")
      if (seen.has(entry)) throw new TypeError("native_verification_value_cyclic")
      seen.add(entry)
      try { return entry.map(child => visit(child, depth + 1)) } finally { seen.delete(entry) }
    }
    const object = row(entry)
    if (object) {
      if (seen.has(object)) throw new TypeError("native_verification_value_cyclic")
      seen.add(object)
      try {
        return Object.fromEntries(Object.keys(object).sort().map(key => {
          account(Buffer.byteLength(key, "utf8"))
          return [key, visit(object[key], depth + 1)]
        }))
      } finally { seen.delete(object) }
    }
    throw new TypeError("native_verification_value_not_json")
  }
  const canonical = JSON.stringify(visit(value, 0))
  if (Buffer.byteLength(canonical, "utf8") > MAX_CANONICAL_BYTES) throw new TypeError("native_verification_value_too_large")
  return canonical
}

export function digestNativeVerificationValue(value: unknown): string {
  return createHash("sha256").update(canonicalNativeVerificationJson(value), "utf8").digest("hex")
}
