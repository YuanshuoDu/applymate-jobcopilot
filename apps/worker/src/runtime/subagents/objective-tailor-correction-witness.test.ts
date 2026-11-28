import { describe, expect, it } from "vitest"
import { bindObjectiveTailorWaveCandidateWitness, makeObjectiveTailorWaveCandidateSelection } from "./objective-tailor-wave-witness.js"
import { bindObjectiveTailorCorrectionProof, objectiveTailorCorrectionNodeKeys,
  parseObjectiveTailorCorrectionProof, OBJECTIVE_TAILOR_CORRECTION_PROOF_SCHEMA } from "./objective-tailor-correction-witness.js"

const hash = (char: string) => `sha256:${char.repeat(64)}`
function proof() {
  const scope = { userId: "u", sessionId: "s", turnId: "t", rootTaskId: "r", parentTaskId: "r" }
  const selection = makeObjectiveTailorWaveCandidateSelection({ scope, sourceGraphRevision: 2,
    sourceGraphDigest: "a".repeat(64), sourceStatusDigest: "b".repeat(64), analystProofDigest: "c".repeat(64),
    candidate: { jobId: "f47ac10b-58cc-4372-a567-0e02b2c3d471", score: 8, materialDigest: hash("d") }, sourceAnalystKey: "analyst" })!
  const candidateWitness = bindObjectiveTailorWaveCandidateWitness(selection, { slotId: "tailor-1", admittedRevision: 3 })!
  const artifactRef = { artifactId: "artifact", version: 2, contentHash: hash("e"), sourceDigest: hash("f") }
  return bindObjectiveTailorCorrectionProof({ graphRevision: 5, slotId: "tailor-1", candidateWitness,
    writerTaskId: "writer-task", reviewerTaskId: "reviewer-task", artifactRef,
    artifactVersion: { ...artifactRef, artifactType: "cover_letter", taskId: "writer-task", previousHash: hash("a") },
    reviewReceipt: { jobId: candidateWitness.candidate.jobId, ...artifactRef, currentSourceDigest: artifactRef.sourceDigest,
      status: "needs_revision", taskId: "reviewer-task", toolCallId: "review-call", reviewHash: hash("b") } })
}

describe("Objective Tailor correction witness codec", () => {
  it("round trips the exact closed needs_revision witness", () => {
    const value = proof()
    expect(value?.schemaVersion).toBe(OBJECTIVE_TAILOR_CORRECTION_PROOF_SCHEMA)
    expect(parseObjectiveTailorCorrectionProof(value)).toEqual(value)
  })

  it("uses deterministic slot-only successor keys and rejects malformed or altered proof", () => {
    const value = proof()!
    expect(objectiveTailorCorrectionNodeKeys("tailor-2")).toEqual({
      writerNodeKey: "objective-tailor-wave-correction-writer-tailor-2",
      reviewerNodeKey: "objective-tailor-wave-correction-reviewer-tailor-2",
    })
    expect(objectiveTailorCorrectionNodeKeys("tailor-9")).toBeUndefined()
    expect(parseObjectiveTailorCorrectionProof({ ...value, extra: true })).toBeUndefined()
    expect(parseObjectiveTailorCorrectionProof({ ...value, slotId: "tailor-2" })).toBeUndefined()
    expect(parseObjectiveTailorCorrectionProof({ ...value, prior: { ...value.prior,
      reviewReceipt: { ...value.prior.reviewReceipt, status: "passed" } } })).toBeUndefined()
  })
})
