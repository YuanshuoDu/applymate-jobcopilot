import { describe, expect, it } from "vitest"
import {
  bindObjectiveTailorWaveCandidateWitness,
  makeObjectiveTailorWaveCandidateSelection,
  objectiveTailorWavePairPlan,
  parseObjectiveTailorWaveCandidateRefs,
  parseObjectiveTailorWaveCandidateWitness,
} from "./objective-tailor-wave-witness.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"

const scope: GraphIdentityScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
const jobId = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
const selection = (material = `sha256:${"d".repeat(64)}`, proof = "c".repeat(64)) => makeObjectiveTailorWaveCandidateSelection({
  scope, sourceGraphRevision: 4, sourceGraphDigest: "a".repeat(64), sourceStatusDigest: "b".repeat(64),
  analystProofDigest: proof, candidate: { jobId, score: 8.5, materialDigest: material }, sourceAnalystKey: "analyst-a",
})!
function witness(slotId = "tailor-1", admittedRevision = 5) {
  return bindObjectiveTailorWaveCandidateWitness(selection(), { slotId, admittedRevision })!
}

describe("Objective Tailor wave witness", () => {
  it("binds an opaque candidate reference to stable source proof and current Job material", () => {
    const first = selection(), sameAfterGraphChurn = selection()
    expect(first.candidateRef).toBe(sameAfterGraphChurn.candidateRef)
    expect(first.candidateRef).not.toContain(jobId)
    expect(selection(`sha256:${"e".repeat(64)}`).candidateRef).not.toBe(first.candidateRef)
    expect(selection(undefined, "f".repeat(64)).candidateRef).not.toBe(first.candidateRef)
    const differentOwner = makeObjectiveTailorWaveCandidateSelection({ scope: { ...scope, userId: "user-2" },
      sourceGraphRevision: first.sourceGraphRevision, sourceGraphDigest: first.sourceGraphDigest,
      sourceStatusDigest: first.sourceStatusDigest, analystProofDigest: first.analystProofDigest,
      candidate: first.candidate, sourceAnalystKey: "analyst-a" })
    expect(differentOwner?.candidateRef).not.toBe(first.candidateRef)
  })

  it("constructs the only per-slot pair plan with slot-only public keys", () => {
    const bound = witness(), plan = objectiveTailorWavePairPlan(bound)!
    expect(plan.proposal.expectedRevision).toBe(4)
    expect(plan.proposal.nodes.map(node => [node.key, node.templateId, node.dependsOn])).toEqual([
      [bound.writerNodeKey, "cover_letter_writer", ["analyst-a"]],
      [bound.reviewerNodeKey, "cover_letter_reviewer", [bound.writerNodeKey]],
    ])
    expect(bound.writerNodeKey).toBe("objective-tailor-wave-writer-tailor-1")
    expect(bound.reviewerNodeKey).toBe("objective-tailor-wave-reviewer-tailor-1")
    expect(bound.writerNodeKey).not.toContain(bound.candidateRef)
    expect(plan.templatesByNodeKey.get(bound.writerNodeKey)).toMatchObject({ role: "writer", taskType: "cover_letter_draft",
      context: { objectiveTailorCandidateMode: true, selectedJobPreparation: { jobId }, objectiveTailorCandidateWitness: bound } })
    expect(plan.templatesByNodeKey.get(bound.reviewerNodeKey)).toMatchObject({ role: "reviewer", taskType: "cover_letter_review" })
  })

  it("accepts only exact slot and admission bindings", () => {
    const good = witness()
    expect(parseObjectiveTailorWaveCandidateWitness(good)).toEqual(good)
    expect(bindObjectiveTailorWaveCandidateWitness(selection(), { slotId: "tailor-9", admittedRevision: 5 })).toBeUndefined()
    expect(bindObjectiveTailorWaveCandidateWitness(selection(), { slotId: "tailor-1", admittedRevision: 4 })).toBeUndefined()
    expect(parseObjectiveTailorWaveCandidateWitness({ ...good, slotId: "tailor-2" })).toBeUndefined()
    expect(parseObjectiveTailorWaveCandidateWitness({ ...good, writerNodeKey: "forged" })).toBeUndefined()
    expect(parseObjectiveTailorWaveCandidateWitness({ ...good, candidateRef: [] })).toBeUndefined()
    expect(parseObjectiveTailorWaveCandidateWitness({ ...good, candidate: { ...good.candidate, jobId: [] } })).toBeUndefined()
    expect(parseObjectiveTailorWaveCandidateWitness({ ...good, privateExtra: true })).toBeUndefined()
    expect(parseObjectiveTailorWaveCandidateWitness({ ...good, sourceGraphRevision: 0 })).toBeUndefined()
    expect(parseObjectiveTailorWaveCandidateWitness({ ...good, sourceGraphRevision: -1 })).toBeUndefined()
    expect(parseObjectiveTailorWaveCandidateWitness({ ...good, sourceGraphRevision: 2_147_483_647 })).toBeUndefined()
    expect(parseObjectiveTailorWaveCandidateWitness({ ...good, admittedRevision: 0 })).toBeUndefined()
    expect(parseObjectiveTailorWaveCandidateWitness({ ...good, admittedRevision: 2_147_483_647 })).toBeUndefined()
  })

  it("parses only a bounded dense list of distinct opaque candidate references", () => {
    const first = selection(), second = makeObjectiveTailorWaveCandidateSelection({ scope, sourceGraphRevision: 4,
      sourceGraphDigest: "a".repeat(64), sourceStatusDigest: "b".repeat(64), analystProofDigest: "c".repeat(64),
      candidate: { ...first.candidate, jobId: "f47ac10b-58cc-4372-a567-0e02b2c3d470" }, sourceAnalystKey: "analyst-a" })!
    const refs = [first.candidateRef, second.candidateRef]
    expect(parseObjectiveTailorWaveCandidateRefs(refs)).toEqual(refs)
    expect(parseObjectiveTailorWaveCandidateRefs([...refs, refs[0]])).toBeUndefined()
    expect(parseObjectiveTailorWaveCandidateRefs([...refs, ...refs, ...refs])).toBeUndefined()
    expect(parseObjectiveTailorWaveCandidateRefs(["otc2_bad"])).toBeUndefined()
    const sparse = new Array(1)
    expect(parseObjectiveTailorWaveCandidateRefs(sparse)).toBeUndefined()
    const accessor = [] as unknown[]
    Object.defineProperty(accessor, "0", { enumerable: true, get: () => refs[0] })
    expect(parseObjectiveTailorWaveCandidateRefs(accessor)).toBeUndefined()
    expect(parseObjectiveTailorWaveCandidateRefs(new Proxy([], { getPrototypeOf: () => { throw new Error("untrusted") } }))).toBeUndefined()
  })

  it("rejects sparse or accessor source keys and noncanonical candidate inputs", () => {
    const good = witness()
    const sparse: string[] = []
    sparse.length = 1
    expect(parseObjectiveTailorWaveCandidateWitness({ ...good, sourceAnalystKeys: sparse })).toBeUndefined()
    const accessor = [] as unknown[]
    Object.defineProperty(accessor, "0", { enumerable: true, get: () => "analyst-a" })
    accessor.length = 1
    expect(parseObjectiveTailorWaveCandidateWitness({ ...good, sourceAnalystKeys: accessor })).toBeUndefined()
    const base = selection()
    expect(makeObjectiveTailorWaveCandidateSelection({ scope, sourceGraphRevision: base.sourceGraphRevision,
      sourceGraphDigest: base.sourceGraphDigest, sourceStatusDigest: base.sourceStatusDigest,
      analystProofDigest: base.analystProofDigest, candidate: { ...base.candidate, jobId: "not-a-job-id" },
      sourceAnalystKey: "analyst-a" })).toBeUndefined()
  })
})
