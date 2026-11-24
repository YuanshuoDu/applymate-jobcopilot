import { describe, expect, it } from "vitest"
import {
  bindObjectiveTailorCandidateWitness,
  makeObjectiveTailorCandidateSelection,
  parseObjectiveTailorCandidateSelection,
  parseObjectiveTailorCandidateWitness,
} from "./objective-tailor-witness.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"

const scope: GraphIdentityScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
const digest = "a".repeat(64)
const selection = () => makeObjectiveTailorCandidateSelection({ scope, sourceGraphRevision: 4, sourceGraphDigest: digest,
  sourceStatusDigest: "b".repeat(64), analystProofDigest: "c".repeat(64),
  candidate: { jobId: "f47ac10b-58cc-4372-a567-0e02b2c3d479", score: 8.5, materialDigest: `sha256:${"d".repeat(64)}` },
  sourceAnalystKeys: ["analyst-a", "analyst-b"] })!

describe("objective tailor candidate witness", () => {
  it("creates a closed witness binding source proof, selected candidate and admitted pair revision", () => {
    const witness = bindObjectiveTailorCandidateWitness(selection(), { writerNodeKey: "tailor-writer", reviewerNodeKey: "tailor-reviewer", admittedRevision: 5 })
    expect(witness).toMatchObject({ candidateRef: selection().candidateRef, sourceGraphRevision: 4, admittedRevision: 5,
      writerNodeKey: "tailor-writer", reviewerNodeKey: "tailor-reviewer", sourceAnalystKeys: ["analyst-a", "analyst-b"] })
    expect(parseObjectiveTailorCandidateWitness(witness)).toEqual(witness)
    expect(parseObjectiveTailorCandidateSelection(selection())).toEqual(selection())
  })

  it.each([
    { writerNodeKey: "tailor-writer", reviewerNodeKey: "tailor-reviewer", admittedRevision: 6 },
    { writerNodeKey: "analyst-a", reviewerNodeKey: "tailor-reviewer", admittedRevision: 5 },
    { writerNodeKey: "tailor-writer", reviewerNodeKey: "tailor-writer", admittedRevision: 5 },
  ])("rejects a pair that is not a new exact successor", pair => expect(bindObjectiveTailorCandidateWitness(selection(), pair)).toBeUndefined())

  it("rejects unknown fields, altered refs, malformed evidence, and noncanonical key order", () => {
    const witness = bindObjectiveTailorCandidateWitness(selection(), { writerNodeKey: "tailor-writer", reviewerNodeKey: "tailor-reviewer", admittedRevision: 5 })!
    expect(parseObjectiveTailorCandidateWitness({ ...witness, extra: true })).toBeUndefined()
    expect(parseObjectiveTailorCandidateWitness({ ...witness, candidateRef: "unknown" })).toBeUndefined()
    expect(parseObjectiveTailorCandidateWitness({ ...witness, analystProofDigest: "not-a-digest" })).toBeUndefined()
    expect(parseObjectiveTailorCandidateWitness({ ...witness, sourceAnalystKeys: ["analyst-b", "analyst-a"] })).toBeUndefined()
    expect(parseObjectiveTailorCandidateWitness({ ...witness, candidateRef: [] })).toBeUndefined()
    expect(parseObjectiveTailorCandidateWitness({ ...witness, candidate: { ...witness.candidate, materialDigest: [] } })).toBeUndefined()
    const sparse = ["analyst-a", "analyst-b"]
    delete sparse[0]
    expect(parseObjectiveTailorCandidateWitness({ ...witness, sourceAnalystKeys: sparse })).toBeUndefined()
    const extended = ["analyst-a", "analyst-b"] as string[] & { extra?: string }
    extended.extra = "hidden"
    expect(parseObjectiveTailorCandidateWitness({ ...witness, sourceAnalystKeys: extended })).toBeUndefined()
  })

  it("binds opaque references to owner, graph revision and material evidence", () => {
    const original = selection()
    const changedOwner = makeObjectiveTailorCandidateSelection({ ...original, scope: { ...scope, userId: "user-2" } })
    const changedRevision = makeObjectiveTailorCandidateSelection({ ...original, scope, sourceGraphRevision: 5 })
    const changedMaterial = makeObjectiveTailorCandidateSelection({ ...original, scope,
      candidate: { ...original.candidate, materialDigest: `sha256:${"e".repeat(64)}` } })
    expect(changedOwner?.candidateRef).not.toBe(original.candidateRef)
    expect(changedRevision?.candidateRef).not.toBe(original.candidateRef)
    expect(changedMaterial?.candidateRef).not.toBe(original.candidateRef)
  })
})
