import { Buffer } from "node:buffer"
import {
  NATIVE_VERIFICATION_USER_SELF_ATTESTATION_REFERENCE_PREFIX,
  canonicalNativeVerificationJson,
  type NativeVerificationEvidence,
} from "./native-verification-contract.js"

export const NATIVE_VERIFICATION_USER_STEERING_SCHEMA = "native-user-steering.v1" as const
export const NATIVE_VERIFICATION_USER_STEERING_STAGE = "user_steering" as const
export const NATIVE_VERIFICATION_USER_STEERING_MAX_INPUTS = 16
export const NATIVE_VERIFICATION_USER_STEERING_MAX_SOURCE_BYTES = 16 * 1024
export const NATIVE_VERIFICATION_USER_STEERING_MAX_TOTAL_BYTES = 64 * 1024
export const NATIVE_VERIFICATION_USER_STEERING_MAX_PARTS = 32

export function nativeSteeringCheckpointInputIdsMatch(
  checkpointIds: readonly string[], originalInputId: string | null, steeringInputIds: readonly string[],
): boolean {
  const expected = new Set(steeringInputIds)
  if (originalInputId) expected.add(originalInputId)
  return checkpointIds.length === expected.size && checkpointIds.every(inputId => expected.has(inputId))
}

export function parseNativeSteeringTurnInput(value: unknown): Readonly<{ clientMessageId: string; content: readonly unknown[] }> | null {
  const envelope = object(value), nested = object(envelope?.input)
  const turnInput = nested && Object.keys(nested).length > 0 ? nested : envelope
  const content = turnInput?.content
  const messageId = turnInput?.clientMessageId
  if (!turnInput || typeof messageId !== "string" || !messageId.trim() || messageId.length > 256
    || !Array.isArray(content) || content.length < 1) return null
  return { clientMessageId: messageId, content }
}

export type NativeUserSteeringTextPart = Readonly<{ type: "text"; text: string }>
export type NativeUserSteeringSummary = Readonly<{
  schemaVersion: typeof NATIVE_VERIFICATION_USER_STEERING_SCHEMA
  stage: typeof NATIVE_VERIFICATION_USER_STEERING_STAGE
  content: readonly NativeUserSteeringTextPart[]
}>

function object(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.getOwnPropertyNames(value).length !== Object.keys(value).length
    || Object.values(descriptors).some(item => !item.enumerable || !("value" in item))) return null
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
}

export function parseNativeUserSteeringContent(value: unknown): NativeUserSteeringSummary["content"] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < 1 || value.length > NATIVE_VERIFICATION_USER_STEERING_MAX_PARTS
    || Object.getOwnPropertySymbols(value).length || Object.getOwnPropertyNames(value).length !== value.length + 1) return null
  const result: NativeUserSteeringTextPart[] = []
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return null
    const part = object(value[index])
    if (!part || !exactKeys(part, ["type", "text"]) || part.type !== "text"
      || typeof part.text !== "string" || part.text.length < 1) return null
    result.push({ type: "text", text: part.text })
  }
  return result
}

export function isNativeSteeringEvidence(value: unknown): value is NativeVerificationEvidence {
  const evidence = object(value)
  if (!evidence || !exactKeys(evidence, ["referenceId", "kind", "summary"])
    || evidence.kind !== "user_self_attestation"
    || typeof evidence.referenceId !== "string"
    || !new RegExp(`^${NATIVE_VERIFICATION_USER_SELF_ATTESTATION_REFERENCE_PREFIX}[a-f0-9]{64}$`).test(evidence.referenceId)
    || typeof evidence.summary !== "string"
    || Buffer.byteLength(evidence.summary, "utf8") > NATIVE_VERIFICATION_USER_STEERING_MAX_SOURCE_BYTES) return false
  try {
    const parsed = object(JSON.parse(evidence.summary))
    if (!parsed || !exactKeys(parsed, ["schemaVersion", "stage", "content"])
      || parsed.schemaVersion !== NATIVE_VERIFICATION_USER_STEERING_SCHEMA
      || parsed.stage !== NATIVE_VERIFICATION_USER_STEERING_STAGE) return false
    const content = parseNativeUserSteeringContent(parsed.content)
    return content !== null && canonicalNativeVerificationJson({
      schemaVersion: NATIVE_VERIFICATION_USER_STEERING_SCHEMA,
      stage: NATIVE_VERIFICATION_USER_STEERING_STAGE,
      content,
    }) === evidence.summary
  } catch { return false }
}
