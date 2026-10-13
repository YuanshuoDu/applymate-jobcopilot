import type pg from "pg"
import { NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND, isNativeVerificationUserSelfAttestationReference,
  type NativeVerificationEvidence } from "./native-verification-contract.js"
import { readNativeVerificationQuestionSource, readNativeVerificationLiveQuestionTurn } from "./native-verification-question-source.js"
import { appendNativePriorQuestionSelfAttestations } from "./native-verification-prior-question-evidence.js"
import type { NativeVerificationPacketContent } from "./native-verification-pg-evidence.js"
import type { TaskGraphReadScope } from "./task-graph-command-port.js"

type Client = Pick<pg.PoolClient, "query">
const MAX_CURRENT_QUESTIONS = 64
const MAX_PACKET_EVIDENCE = 32

/** Appends only complete, server-rederived root user-input answers; never clips answers. */
export async function appendNativeQuestionSelfAttestations(
  client: Client, scope: TaskGraphReadScope, content: NativeVerificationPacketContent,
): Promise<NativeVerificationPacketContent | null> {
  if (content.target.kind !== "root_goal" || scope.parentTaskId !== scope.rootTaskId
    || content.evidence.some(item => item.kind === NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND
      || isNativeVerificationUserSelfAttestationReference(item.referenceId))) return null
  const liveTurn = await readNativeVerificationLiveQuestionTurn(client, scope)
  if (!liveTurn) return null
  const current = await readNativeVerificationQuestionSource(client, liveTurn.identity, MAX_CURRENT_QUESTIONS)
  if (!current || current.length > MAX_PACKET_EVIDENCE - content.evidence.length) return null
  const protectedEvidence: readonly NativeVerificationEvidence[] = [...content.evidence, ...current]
  return appendNativePriorQuestionSelfAttestations(client, liveTurn, { ...content, evidence: protectedEvidence })
}
