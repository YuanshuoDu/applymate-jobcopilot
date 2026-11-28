import { afterEach, describe, expect, it, vi } from "vitest"
const completionVerifier = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock("../canonical-objective-tailor-wave-completion.js", () => ({
  verifyCanonicalObjectiveTailorWaveCompletion: completionVerifier.run,
}))
import { bindObjectiveTailorWaveCandidateWitness, makeObjectiveTailorWaveCandidateSelection } from "./objective-tailor-wave-witness.js"
import {
  bindObjectiveTailorCorrectionProof, objectiveTailorCorrectionNodeKeys, parseObjectiveTailorCorrectionProof,
  verifyAndBindObjectiveTailorCorrectionProof,
  type ObjectiveTailorCorrectionProof,
} from "./objective-tailor-correction-proof.js"
import type { ObjectiveTailorWaveCompletionResult, ObjectiveTailorWaveCompletionWitness,
  ObjectiveTailorWaveSlotOutcome } from "../canonical-objective-tailor-wave-completion.js"

const sha = (char: string) => `sha256:${char.repeat(64)}`
afterEach(() => completionVerifier.run.mockReset())

function evidence() {
  const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
  const selection = makeObjectiveTailorWaveCandidateSelection({ scope, sourceGraphRevision: 1,
    sourceGraphDigest: "a".repeat(64), sourceStatusDigest: "b".repeat(64), analystProofDigest: "c".repeat(64),
    candidate: { jobId: "f47ac10b-58cc-4372-a567-0e02b2c3d479", score: 8.5, materialDigest: sha("d") }, sourceAnalystKey: "analyst-1" })
  if (!selection) throw new Error("candidate_selection_invalid")
  const candidateWitness = bindObjectiveTailorWaveCandidateWitness(selection, { slotId: "tailor-1", admittedRevision: 2 })
  if (!candidateWitness) throw new Error("candidate_witness_invalid")
  const artifactRef = { artifactId: "cover-letter-1", version: 3, contentHash: sha("e"), sourceDigest: sha("f") }
  const artifactVersion = { ...artifactRef, artifactType: "cover_letter" as const, taskId: "writer-task-1", previousHash: sha("a") }
  const reviewReceipt = { jobId: candidateWitness.candidate.jobId, ...artifactRef, currentSourceDigest: artifactRef.sourceDigest,
    status: "needs_revision" as const, taskId: "reviewer-task-1", toolCallId: "c".repeat(256), reviewHash: sha("b") }
  const build = (overrides: Partial<Parameters<typeof bindObjectiveTailorCorrectionProof>[0]> = {}) =>
    bindObjectiveTailorCorrectionProof({ graphRevision: 5, slotId: "tailor-1", candidateWitness,
      writerTaskId: "writer-task-1", reviewerTaskId: "reviewer-task-1", artifactRef, artifactVersion, reviewReceipt, ...overrides })
  return { candidateWitness, artifactRef, artifactVersion, reviewReceipt, build }
}

function verifiedOutcome(): ObjectiveTailorWaveSlotOutcome {
  const { candidateWitness, artifactRef, artifactVersion, reviewReceipt } = evidence()
  return { slotId: "tailor-1", jobId: candidateWitness.candidate.jobId, writerTaskId: "writer-task-1", reviewerTaskId: "reviewer-task-1",
    status: "needs_revision", candidateWitness, artifactRef, artifactVersion,
    currentSourceDigest: artifactRef.sourceDigest,
    reviewReceipt: { taskId: reviewReceipt.taskId, artifactId: reviewReceipt.artifactId, version: reviewReceipt.version,
      contentHash: reviewReceipt.contentHash, sourceDigest: reviewReceipt.sourceDigest,
      currentSourceDigest: reviewReceipt.currentSourceDigest, status: reviewReceipt.status,
      reviewHash: reviewReceipt.reviewHash, toolCallId: reviewReceipt.toolCallId } }
}
function ready(outcomes: readonly ObjectiveTailorWaveSlotOutcome[]): ObjectiveTailorWaveCompletionResult {
  return { status: "ready", outcomes, witness: {} as ObjectiveTailorWaveCompletionWitness }
}

describe("Objective Tailor correction proof", () => {
  it("binds a verified needs_revision receipt to deterministic same-slot successor keys", () => {
    const { build } = evidence(), proof = build()
    expect(proof).toMatchObject({ slotId: "tailor-1", graphRevision: 5, admittedRevision: 6,
      writerNodeKey: "objective-tailor-wave-correction-writer-tailor-1",
      reviewerNodeKey: "objective-tailor-wave-correction-reviewer-tailor-1",
      prior: { writerTaskId: "writer-task-1", reviewerTaskId: "reviewer-task-1",
        artifactRef: { artifactId: "cover-letter-1", version: 3 }, reviewReceipt: { status: "needs_revision" } } })
    expect(parseObjectiveTailorCorrectionProof(proof)).toEqual(proof)
  })

  it("derives keys from slot only and rejects unknown slots", () => {
    expect(objectiveTailorCorrectionNodeKeys("tailor-8")).toEqual({
      writerNodeKey: "objective-tailor-wave-correction-writer-tailor-8",
      reviewerNodeKey: "objective-tailor-wave-correction-reviewer-tailor-8",
    })
    expect(objectiveTailorCorrectionNodeKeys("tailor-9")).toBeUndefined()
    expect(objectiveTailorCorrectionNodeKeys("job-1")).toBeUndefined()
  })

  it("rejects wrong slot, wrong task identity, and a correction without a current needs_revision receipt", () => {
    const { candidateWitness, artifactRef, artifactVersion, reviewReceipt, build } = evidence()
    expect(build({ slotId: "tailor-2" })).toBeUndefined()
    expect(build({ writerTaskId: "reviewer-task-1" })).toBeUndefined()
    expect(build({ reviewerTaskId: "other-reviewer" })).toBeUndefined()
    expect(build({ reviewReceipt: { ...reviewReceipt, status: "passed" } })).toBeUndefined()
    expect(build({ reviewReceipt: { ...reviewReceipt, currentSourceDigest: sha("0") } })).toBeUndefined()
    expect(build({ reviewReceipt: { ...reviewReceipt, jobId: "job-2" } })).toBeUndefined()
    expect(build({ artifactVersion: { ...artifactVersion, contentHash: sha("0") } })).toBeUndefined()
    expect(build({ artifactRef: { ...artifactRef, version: 4 } })).toBeUndefined()
    expect(candidateWitness.candidate.jobId).toBe("f47ac10b-58cc-4372-a567-0e02b2c3d479")
  })

  it("rejects altered closed witness keys, revisions, and artifact lineage fields", () => {
    const { build, candidateWitness } = evidence(), proof = build()
    if (!proof) throw new Error("fixture_proof_invalid")
    expect(build({ candidateWitness: { ...candidateWitness, admittedRevision: 6 } })).toBeUndefined()
    const mutate = (patch: Partial<ObjectiveTailorCorrectionProof>) => ({ ...proof, ...patch })
    expect(parseObjectiveTailorCorrectionProof(mutate({ admittedRevision: 7 }))).toBeUndefined()
    expect(parseObjectiveTailorCorrectionProof(mutate({ writerNodeKey: "writer-for-another-slot" }))).toBeUndefined()
    expect(parseObjectiveTailorCorrectionProof({ ...proof, added: true })).toBeUndefined()
    expect(parseObjectiveTailorCorrectionProof({ ...proof, prior: { ...proof.prior,
      artifactVersion: { ...proof.prior.artifactVersion, previousHash: "not-a-hash" } } })).toBeUndefined()
    expect(parseObjectiveTailorCorrectionProof({ ...proof, prior: { ...proof.prior,
      reviewReceipt: { ...proof.prior.reviewReceipt, toolCallId: "" } } })).toBeUndefined()
  })

  it("keeps each slot's successor identity independent", () => {
    const keys = objectiveTailorCorrectionNodeKeys("tailor-2")
    expect(keys?.writerNodeKey).not.toBe(objectiveTailorCorrectionNodeKeys("tailor-1")?.writerNodeKey)
    expect(keys?.reviewerNodeKey).not.toBe(objectiveTailorCorrectionNodeKeys("tailor-1")?.reviewerNodeKey)
  })

  it("revalidates on the caller client and admits a completed target while another slot is pending", async () => {
    const target = verifiedOutcome(), client = {}, lease = {}, root = { id: "root-1", attemptCount: 1 }
    const loaded = { item: { revision: 5 }, snapshot: { nodes: [] } }
    const other = { ...target, slotId: "tailor-2", status: "pending" as const }
    completionVerifier.run.mockResolvedValueOnce({ status: "pending", outcomes: [target, other] } satisfies ObjectiveTailorWaveCompletionResult)
    const proof = await verifyAndBindObjectiveTailorCorrectionProof({ client: client as never, lease: lease as never,
      root, loaded: loaded as never, slotId: "tailor-1", expectedRevision: 5 })
    expect(proof).toMatchObject({ slotId: "tailor-1", graphRevision: 5, admittedRevision: 6,
      prior: { reviewReceipt: { status: "needs_revision", toolCallId: "c".repeat(256) } } })
    expect(completionVerifier.run).toHaveBeenCalledWith({ client, lease, root, loaded, allowAbsent: false })
  })

  it("fails closed for blocked, target-pending, duplicate-slot, stale-revision, or occupied successor evidence", async () => {
    const target = verifiedOutcome(), client = {}, lease = {}, root = { id: "root-1", attemptCount: 1 }
    const loaded = { item: { revision: 5 }, snapshot: { nodes: [] } }
    const read = (result: ObjectiveTailorWaveCompletionResult, revision = 5, nodes: readonly { key: string }[] = []) => {
      completionVerifier.run.mockResolvedValueOnce(result)
      return verifyAndBindObjectiveTailorCorrectionProof({ client: client as never, lease: lease as never,
        root, loaded: { item: { revision }, snapshot: { nodes } } as never, slotId: "tailor-1", expectedRevision: 5 })
    }
    expect(await read({ status: "blocked", outcomes: [target] })).toBeUndefined()
    expect(await read({ status: "pending", outcomes: [{ ...target, status: "pending" }] })).toBeUndefined()
    expect(await read(ready([target, target]))).toBeUndefined()
    expect(await read(ready([target]), 4)).toBeUndefined()
    expect(await read(ready([target]), 5, [{ key: "objective-tailor-wave-correction-writer-tailor-1" }])).toBeUndefined()
    completionVerifier.run.mockReset()
    completionVerifier.run.mockRejectedValueOnce(new Error("read_failed"))
    expect(await verifyAndBindObjectiveTailorCorrectionProof({ client: client as never, lease: lease as never,
      root, loaded: loaded as never, slotId: "tailor-1", expectedRevision: 5 })).toBeUndefined()
  })

  it("rejects needs_revision evidence whose persisted source or artifact proof is incomplete", async () => {
    const target = verifiedOutcome(), client = {}, lease = {}, root = { id: "root-1", attemptCount: 1 }
    const loaded = { item: { revision: 5 }, snapshot: { nodes: [] } }
    completionVerifier.run.mockResolvedValueOnce(ready([
      { ...target, reviewReceipt: { ...target.reviewReceipt!, currentSourceDigest: sha("0") } },
    ]))
    expect(await verifyAndBindObjectiveTailorCorrectionProof({ client: client as never, lease: lease as never,
      root, loaded: loaded as never, slotId: "tailor-1", expectedRevision: 5 })).toBeUndefined()
    completionVerifier.run.mockResolvedValueOnce(ready([
      { ...target, artifactVersion: undefined },
    ]))
    expect(await verifyAndBindObjectiveTailorCorrectionProof({ client: client as never, lease: lease as never,
      root, loaded: loaded as never, slotId: "tailor-1", expectedRevision: 5 })).toBeUndefined()
  })
})
