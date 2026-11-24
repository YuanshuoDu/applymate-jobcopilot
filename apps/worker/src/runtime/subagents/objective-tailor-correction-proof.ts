import type { PoolClient } from "pg"
import { verifyCanonicalObjectiveTailorWaveCompletion, type ObjectiveTailorWaveCompletionResult,
  type ObjectiveTailorWaveSlotOutcome } from "../canonical-objective-tailor-wave-completion.js"
import type { LoadedGraph } from "./task-graph-pg-state.js"
import type { SubagentTaskRecord } from "./types.js"
import type { TurnLease } from "../turns/lease.js"
import { parseObjectiveTailorWaveCandidateWitness } from "./objective-tailor-wave-witness.js"
import { bindObjectiveTailorCorrectionProof, objectiveTailorCorrectionNodeKeys,
  parseObjectiveTailorCorrectionProof, type ObjectiveTailorCorrectionProof } from "./objective-tailor-correction-witness.js"

export * from "./objective-tailor-correction-witness.js"

/** Revalidates the exact current wave on the caller's locked client before binding one correction. */
export async function verifyAndBindObjectiveTailorCorrectionProof(input: Readonly<{
  client: PoolClient; lease: TurnLease; root: Pick<SubagentTaskRecord, "id" | "attemptCount">
  loaded: LoadedGraph; slotId: string; expectedRevision: number
}>): Promise<ObjectiveTailorCorrectionProof | undefined> {
  const graphRevision = input.loaded.item?.revision, keys = objectiveTailorCorrectionNodeKeys(input.slotId)
  if (!keys || !revision(graphRevision) || input.expectedRevision !== graphRevision
    || input.loaded.snapshot?.nodes.some(node => node.key === keys.writerNodeKey || node.key === keys.reviewerNodeKey)) return undefined
  let result: ObjectiveTailorWaveCompletionResult
  try {
    result = await verifyCanonicalObjectiveTailorWaveCompletion({ client: input.client, lease: input.lease,
      root: input.root, loaded: input.loaded, allowAbsent: false })
  } catch { return undefined }
  if (result.status !== "ready" && result.status !== "pending") return undefined
  const matching = result.outcomes.filter(outcome => outcome.slotId === input.slotId), target = matching[0]
  if (matching.length !== 1 || !target || target.status !== "needs_revision") return undefined
  if (result.status === "pending" && !result.outcomes.some(outcome => outcome.slotId !== input.slotId && outcome.status === "pending")) return undefined
  if (result.status === "ready" && result.outcomes.some(outcome => outcome.status === "pending")) return undefined
  return bindVerifiedOutcome(graphRevision, target)
}

function bindVerifiedOutcome(graphRevision: number, outcome: ObjectiveTailorWaveSlotOutcome): ObjectiveTailorCorrectionProof | undefined {
  const candidateWitness = parseObjectiveTailorWaveCandidateWitness(outcome.candidateWitness)
  const ref = outcome.artifactRef, version = outcome.artifactVersion, receipt = outcome.reviewReceipt
  if (!candidateWitness || candidateWitness.slotId !== outcome.slotId || candidateWitness.admittedRevision > graphRevision
    || candidateWitness.candidate.jobId !== outcome.jobId || !ref || !version || !receipt
    || outcome.status !== "needs_revision" || outcome.currentSourceDigest !== receipt.currentSourceDigest
    || version.artifactId !== ref.artifactId || version.version !== ref.version || version.taskId !== outcome.writerTaskId
    || version.contentHash !== ref.contentHash || version.sourceDigest !== ref.sourceDigest
    || receipt.taskId !== outcome.reviewerTaskId || receipt.status !== "needs_revision"
    || receipt.artifactId !== ref.artifactId || receipt.version !== ref.version || receipt.contentHash !== ref.contentHash
    || receipt.sourceDigest !== ref.sourceDigest || receipt.currentSourceDigest !== ref.sourceDigest) return undefined
  return bindObjectiveTailorCorrectionProof({ graphRevision, slotId: outcome.slotId, candidateWitness,
    writerTaskId: outcome.writerTaskId, reviewerTaskId: outcome.reviewerTaskId,
    artifactRef: { artifactId: ref.artifactId, version: ref.version, contentHash: ref.contentHash, sourceDigest: ref.sourceDigest },
    artifactVersion: { artifactId: version.artifactId, artifactType: version.artifactType, taskId: version.taskId,
      version: version.version, contentHash: version.contentHash, sourceDigest: version.sourceDigest, previousHash: version.previousHash },
    reviewReceipt: { jobId: outcome.jobId, artifactId: receipt.artifactId, version: receipt.version,
      contentHash: receipt.contentHash, sourceDigest: receipt.sourceDigest, currentSourceDigest: receipt.currentSourceDigest,
      status: receipt.status, taskId: receipt.taskId, toolCallId: receipt.toolCallId, reviewHash: receipt.reviewHash } })
}

function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_646
}
