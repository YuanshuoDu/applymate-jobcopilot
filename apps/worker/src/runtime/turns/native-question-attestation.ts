import { createHash } from "node:crypto"

import { parseTurnQuestionArguments, parseTurnQuestionIntentEnvelope } from "./turn-question-contract.js"

export const NATIVE_QUESTION_ATTESTATION_SCHEMA = "agent-harness.v2.native-question-attestation.v1" as const

export type NativeQuestionAttestationIdentity = {
  readonly userId: string
  readonly sessionId: string
  readonly turnId: string
  readonly stepId: string
  readonly taskId: string
}

export type NativeQuestionAttestation = NativeQuestionAttestationIdentity & {
  readonly schemaVersion: typeof NATIVE_QUESTION_ATTESTATION_SCHEMA
  readonly toolCallId: string
  readonly toolName: "agent.ask_user"
  readonly toolVersion: "1"
  readonly inputDigest: string
}

export type NativeQuestionControlReceipt = { readonly attestation: NativeQuestionAttestation }

const trustedReceipts = new WeakSet<object>()
const ATTESTATION_KEYS = ["schemaVersion", "toolCallId", "toolName", "toolVersion", "userId", "sessionId", "turnId", "stepId", "taskId", "inputDigest"] as const

/** Issue an in-process control receipt only after the built-in root question has been fully validated. */
export function issueNativeQuestionControlReceipt(input: {
  readonly identity: NativeQuestionAttestationIdentity & { readonly rootTaskId?: string }
  readonly actorRole?: string
  readonly capabilities: readonly string[]
  readonly toolCallId: string
  readonly toolName: string
  readonly toolVersion: string
  readonly requestInput: unknown
  readonly effectiveInput: unknown
  readonly toolOutput: unknown
}): NativeQuestionControlReceipt | null {
  const identity = input.identity
  if (input.toolName !== "agent.ask_user" || input.toolVersion !== "1" || !validId(input.toolCallId)
    || input.actorRole !== "orchestrator" || identity.rootTaskId !== identity.taskId
    || ![identity.userId, identity.sessionId, identity.turnId, identity.stepId, identity.taskId].every(validId)
    || !input.capabilities.includes("canManageChildren")) return null

  const requested = parseTurnQuestionArguments(input.requestInput)
  const effective = parseTurnQuestionArguments(input.effectiveInput)
  const produced = parseTurnQuestionIntentEnvelope(input.toolOutput)
  if (!requested || !effective || !produced || !sameIntent(requested, effective) || !sameIntent(requested, produced)) return null

  const attestation: NativeQuestionAttestation = {
    schemaVersion: NATIVE_QUESTION_ATTESTATION_SCHEMA,
    toolCallId: input.toolCallId,
    toolName: "agent.ask_user",
    toolVersion: "1",
    userId: identity.userId,
    sessionId: identity.sessionId,
    turnId: identity.turnId,
    stepId: identity.stepId,
    taskId: identity.taskId,
    inputDigest: digestIntent(requested),
  }
  const receipt = Object.freeze({ attestation: Object.freeze(attestation) })
  trustedReceipts.add(receipt)
  return receipt
}

/** Validate the non-serializable receipt returned by ToolRouter before the Turn persists it. */
export function readTrustedNativeQuestionAttestation(
  receipt: unknown,
  identity: NativeQuestionAttestationIdentity,
  toolCallId: string,
  input: unknown,
): NativeQuestionAttestation | null {
  const row = record(receipt)
  if (!row || Object.keys(row).length !== 1 || !trustedReceipts.has(row) || !Object.hasOwn(row, "attestation")) return null
  return verifyNativeQuestionAttestation(row.attestation, identity, toolCallId, input)
}

/** Validate the durable, server-written attestation against the private stored call input and owner identity. */
export function verifyNativeQuestionAttestation(
  value: unknown,
  identity: NativeQuestionAttestationIdentity,
  toolCallId: string,
  input: unknown,
): NativeQuestionAttestation | null {
  const attestation = parseNativeQuestionAttestation(value)
  const intent = parseTurnQuestionArguments(input)
  if (!attestation || !intent || !validId(toolCallId)
    || attestation.toolCallId !== toolCallId
    || attestation.userId !== identity.userId
    || attestation.sessionId !== identity.sessionId
    || attestation.turnId !== identity.turnId
    || attestation.stepId !== identity.stepId
    || attestation.taskId !== identity.taskId
    || attestation.inputDigest !== digestIntent(intent)) return null
  return attestation
}

export function parseNativeQuestionAttestation(value: unknown): NativeQuestionAttestation | null {
  const row = record(value)
  if (!row || !exactKeys(row, ATTESTATION_KEYS)
    || row.schemaVersion !== NATIVE_QUESTION_ATTESTATION_SCHEMA
    || row.toolName !== "agent.ask_user" || row.toolVersion !== "1"
    || !validId(row.toolCallId) || !validId(row.userId) || !validId(row.sessionId)
    || !validId(row.turnId) || !validId(row.stepId) || !validId(row.taskId)
    || typeof row.inputDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(row.inputDigest)) return null
  return {
    schemaVersion: NATIVE_QUESTION_ATTESTATION_SCHEMA,
    toolCallId: row.toolCallId,
    toolName: "agent.ask_user",
    toolVersion: "1",
    userId: row.userId,
    sessionId: row.sessionId,
    turnId: row.turnId,
    stepId: row.stepId,
    taskId: row.taskId,
    inputDigest: row.inputDigest,
  }
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
  } catch { return null }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",")
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256
}

function sameIntent(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function digestIntent(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`
}
