import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { buildObjectiveApplicationResumeWitness } from "./agent-objective-application-resume-witness.js"
import { canonicalJson } from "./canonical-json.js"
import {
  OBJECTIVE_APPLICATION_REVIEW_MEMBER_PROOF_SCHEMA,
  buildObjectiveApplicationReviewMemberProof,
  parseObjectiveApplicationReviewMemberProof,
} from "./objective-application-review-member-proof.js"

const userId = "owner-1", jobId = "job-1"
const hash = (letter: string) => `sha256:${letter.repeat(64)}`

function seed() {
  const resumeWitness = buildObjectiveApplicationResumeWitness({ userId, jobId, resumeId: "resume-1",
    finalResumeAssignmentRevision: 2, materialRevision: 3, material: { name: "Tailored resume", content: { summary: "Engineer" },
      templateId: null, templateOptions: null, kind: "adapted", targetJobId: jobId, parentResumeId: "base-1", basicsDetached: false } })!
  return { resumeWitness, source: { jobId, sourceTurnId: "source-turn-1", rootTaskId: "root-1", graphItemId: "graph-1",
    graphRevision: 9, finalItemId: "final-1", slotOrdinal: 1, writerTaskId: "writer-1", reviewerTaskId: "reviewer-1",
    reviewerToolCallId: "review-call-1", reviewHash: hash("a"), artifactId: "artifact-1", version: 4,
    contentHash: hash("b"), sourceDigest: hash("c") } }
}

describe("Objective application review member proof", () => {
  it("preserves the exact version-1 canonical material hash and matches a stored approval hash", () => {
    const value = seed(), proof = buildObjectiveApplicationReviewMemberProof(value)!
    const legacyBytes = canonicalJson({ schema: OBJECTIVE_APPLICATION_REVIEW_MEMBER_PROOF_SCHEMA, ...value })
    const legacyHash = createHash("sha256").update(legacyBytes).digest("hex")
    expect(proof.materialProofHash).toBe(legacyHash)
    expect(parseObjectiveApplicationReviewMemberProof(proof)).toEqual(proof)
    expect(proof.materialProofHash).toBe(legacyHash)
    expect(proof.materialProofHash).not.toBe(`sha256:${legacyHash}`)
  })

  it("rejects proof drift, extra keys, mismatched Job witness, and malformed hash", () => {
    const proof = buildObjectiveApplicationReviewMemberProof(seed())!
    expect(parseObjectiveApplicationReviewMemberProof({ ...proof, materialProofHash: "0".repeat(64) })).toBeNull()
    expect(parseObjectiveApplicationReviewMemberProof({ ...proof, unexpected: true })).toBeNull()
    expect(buildObjectiveApplicationReviewMemberProof({ ...seed(), source: { ...proof.source, jobId: "job-2" } })).toBeNull()
    expect(parseObjectiveApplicationReviewMemberProof({ ...proof, materialProofHash: "not-a-hash" })).toBeNull()
  })

  it("rejects accessor and symbol properties instead of serializing them", () => {
    const proof = buildObjectiveApplicationReviewMemberProof(seed())!
    const accessor = { ...proof }
    Object.defineProperty(accessor, "materialProofHash", { enumerable: true, get: () => proof.materialProofHash })
    expect(parseObjectiveApplicationReviewMemberProof(accessor)).toBeNull()
    const symbolic = { ...proof, [Symbol("extra")]: "hidden" }
    expect(parseObjectiveApplicationReviewMemberProof(symbolic)).toBeNull()
  })
})
