import { Buffer } from "node:buffer"
import type pg from "pg"
import {
  NATIVE_VERIFICATION_PACKET_V2_MAX_BYTES, canonicalNativeVerificationJson,
  type NativeVerificationEvidence,
} from "./native-verification-contract.js"
import { appendNativeQuestionSelfAttestations } from "./native-verification-question-evidence.js"
import { isNativeSteeringEvidence } from "./native-verification-steering-contract.js"
import { isNativeOriginalTaskReferenceEvidence } from "./native-verification-original-input-source.js"
import {
  readNativeVerificationUserReferenceSources,
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
  const sources = await readNativeVerificationUserReferenceSources(client, scope, selection)
  if (!sources || !Array.isArray(sources.steering) || sources.steering.length > MAX_STEERING_INPUTS
    || sources.steering.some(item => !isNativeSteeringEvidence(item))
    || !Array.isArray(sources.originalTaskReference) || sources.originalTaskReference.length > 1
    || sources.originalTaskReference.some(item => !isNativeOriginalTaskReferenceEvidence(item))
    || sources.originalTaskReferenceRequired && sources.originalTaskReference.length === 0) return null
  if (!sources.steering.length && !sources.originalTaskReference.length) return withQuestions

  const references = new Set([withQuestions.target.referenceId, ...withQuestions.evidence.map(item => item.referenceId)])
  for (const item of [...sources.originalTaskReference, ...sources.steering]) {
    if (references.has(item.referenceId)) return null
    references.add(item.referenceId)
  }
  const evidence: readonly NativeVerificationEvidence[] = [
    ...withQuestions.evidence, ...sources.originalTaskReference, ...sources.steering,
  ]
  if (evidence.length > MAX_EVIDENCE) return null
  const combined = { ...withQuestions, evidence }
  try {
    if (Buffer.byteLength(canonicalNativeVerificationJson(combined), "utf8") > NATIVE_VERIFICATION_PACKET_V2_MAX_BYTES) return null
  } catch { return null }
  return combined
}
