import { Buffer } from "node:buffer"
import type pg from "pg"
import {
  NATIVE_VERIFICATION_PACKET_V2_MAX_BYTES, canonicalNativeVerificationJson,
  type NativeVerificationEvidence,
} from "./native-verification-contract.js"
import { appendNativeQuestionSelfAttestations } from "./native-verification-question-evidence.js"
import { isNativeSteeringEvidence } from "./native-verification-steering-contract.js"
import {
  readNativeVerificationSteeringSource,
  type NativeSteeringCheckpointSelection,
} from "./native-verification-steering-source.js"
import type { NativeVerificationPacketContent } from "./native-verification-pg-evidence.js"
import type { TaskGraphReadScope } from "./task-graph-command-port.js"

type Client = Pick<pg.PoolClient, "query">
const MAX_STEERING_INPUTS = 16
const MAX_EVIDENCE = 32

/** Rebuilds complete owned user Q/A and steering evidence without clipping. */
export async function appendNativeUserSelfAttestations(
  client: Client,
  scope: TaskGraphReadScope,
  content: NativeVerificationPacketContent,
  selection: NativeSteeringCheckpointSelection,
): Promise<NativeVerificationPacketContent | null> {
  const withQuestions = await appendNativeQuestionSelfAttestations(client, scope, content)
  if (!withQuestions) return null
  const steering = await readNativeVerificationSteeringSource(client, scope, selection)
  if (!steering || !Array.isArray(steering) || steering.length > MAX_STEERING_INPUTS
    || steering.some(item => !isNativeSteeringEvidence(item))) return null
  if (!steering.length) return withQuestions

  const references = new Set([withQuestions.target.referenceId, ...withQuestions.evidence.map(item => item.referenceId)])
  for (const item of steering) {
    if (references.has(item.referenceId)) return null
    references.add(item.referenceId)
  }
  const evidence: readonly NativeVerificationEvidence[] = [...withQuestions.evidence, ...steering]
  if (evidence.length > MAX_EVIDENCE) return null
  const combined = { ...withQuestions, evidence }
  try {
    if (Buffer.byteLength(canonicalNativeVerificationJson(combined), "utf8") > NATIVE_VERIFICATION_PACKET_V2_MAX_BYTES) return null
  } catch { return null }
  return combined
}
