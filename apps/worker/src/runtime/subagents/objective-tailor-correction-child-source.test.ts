import { beforeEach, describe, expect, it, vi } from "vitest"
import { bindObjectiveTailorWaveCandidateWitness, makeObjectiveTailorWaveCandidateSelection } from "./objective-tailor-wave-witness.js"
import { bindObjectiveTailorCorrectionProof, objectiveTailorCorrectionNodeKeys } from "./objective-tailor-correction-proof.js"
import { readObjectiveTailorCorrectionChildBinding } from "./objective-tailor-correction-child-source.js"
import type { GraphIdentityScope, LoadedGraph } from "./task-graph-pg-state.js"

const mocks = vi.hoisted(() => ({ inventory: vi.fn() }))
vi.mock("./objective-tailor-wave-inventory.js", () => ({ readObjectiveTailorWaveInventory: mocks.inventory }))

const scope: GraphIdentityScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
const jobId = "f47ac10b-58cc-4372-a567-0e02b2c3d479", materialDigest = `sha256:${"a".repeat(64)}`
const selection = makeObjectiveTailorWaveCandidateSelection({ scope, sourceGraphRevision: 2, sourceGraphDigest: "b".repeat(64),
  sourceStatusDigest: "c".repeat(64), analystProofDigest: "d".repeat(64), candidate: { jobId, score: 8, materialDigest },
  sourceAnalystKey: "analyst-1" })!
const witness = bindObjectiveTailorWaveCandidateWitness(selection, { slotId: "tailor-1", admittedRevision: 3 })!
const proof = bindObjectiveTailorCorrectionProof({ graphRevision: 4, slotId: witness.slotId, candidateWitness: witness,
  writerTaskId: "writer-initial", reviewerTaskId: "reviewer-initial",
  artifactRef: { artifactId: "artifact-1", version: 2, contentHash: `sha256:${"e".repeat(64)}`, sourceDigest: materialDigest },
  artifactVersion: { artifactId: "artifact-1", artifactType: "cover_letter", taskId: "writer-initial", version: 2,
    contentHash: `sha256:${"e".repeat(64)}`, sourceDigest: materialDigest, previousHash: `sha256:${"f".repeat(64)}` },
  reviewReceipt: { jobId, artifactId: "artifact-1", version: 2, contentHash: `sha256:${"e".repeat(64)}`,
    sourceDigest: materialDigest, currentSourceDigest: materialDigest, status: "needs_revision", taskId: "reviewer-initial",
    toolCallId: "review-call", reviewHash: `sha256:${"1".repeat(64)}` } })!

function fixture() {
  const keys = objectiveTailorCorrectionNodeKeys(witness.slotId)!
  const correction = { proof, writerTaskId: "writer-correction", reviewerTaskId: "reviewer-correction" }
  const context = { objectiveTailorCandidateMode: true, objectiveTailorCandidateWitness: witness,
    objectiveTailorCorrectionProof: proof, selectedJobPreparation: { jobId } }
  const nodes = [
    { key: witness.writerNodeKey, taskId: "writer-initial", templateId: "cover_letter_writer", dependsOn: [] },
    { key: witness.reviewerNodeKey, taskId: "reviewer-initial", templateId: "cover_letter_reviewer", dependsOn: [witness.writerNodeKey] },
    { key: keys.writerNodeKey, taskId: correction.writerTaskId, templateId: "cover_letter_writer", dependsOn: [witness.reviewerNodeKey] },
    { key: keys.reviewerNodeKey, taskId: correction.reviewerTaskId, templateId: "cover_letter_reviewer", dependsOn: [keys.writerNodeKey] },
  ]
  const statuses = new Map(nodes.map(node => [node.taskId, node.taskId === correction.writerTaskId ? "running" : "completed"]))
  const tasks = new Map(nodes.map(node => [node.taskId, { id: node.taskId,
    role: node.templateId === "cover_letter_writer" ? "writer" : "reviewer",
    taskType: node.templateId === "cover_letter_writer" ? "cover_letter_draft" : "cover_letter_review",
    status: statuses.get(node.taskId), failureReason: null }]))
  const loaded = { rootTaskId: scope.rootTaskId, item: { revision: 5 }, snapshot: { nodes },
    state: { nodes: nodes.map(node => ({ key: node.key, taskId: node.taskId, status: statuses.get(node.taskId) })) }, tasks } as unknown as LoadedGraph
  const slot = { slotId: witness.slotId, witness, writerTaskId: "writer-initial", reviewerTaskId: "reviewer-initial", correction }
  mocks.inventory.mockResolvedValue({ marker: { slots: [{ slotId: witness.slotId, writerNodeKey: witness.writerNodeKey,
    reviewerNodeKey: witness.reviewerNodeKey, correction: keys }] }, occupiedSlots: [slot] })
  return { loaded, context, nodes, slot, correction }
}

beforeEach(() => vi.resetAllMocks())

describe("objective tailor correction child binding", () => {
  it.each(["writer", "reviewer"] as const)("binds the %s only to its exact correction slot", async role => {
    const { loaded, context, correction } = fixture()
    const taskId = role === "writer" ? correction.writerTaskId : correction.reviewerTaskId
    const client = { query: vi.fn() }
    const result = await readObjectiveTailorCorrectionChildBinding({ client: client as never, scope, loaded, taskId, role, context })
    expect(result?.proof).toEqual(proof)
    expect(result?.slot.slotId).toBe(witness.slotId)
    expect(mocks.inventory).toHaveBeenCalledWith(client, scope, loaded)
  })

  it.each(["wrong task", "tampered proof", "missing correction", "wrong prior reviewer"] as const)("fails closed for %s", async variant => {
    const { loaded, context, slot, correction } = fixture()
    let taskId = correction.writerTaskId, supplied = context
    if (variant === "wrong task") taskId = "writer-initial"
    if (variant === "tampered proof") supplied = { ...context, objectiveTailorCorrectionProof: { ...proof, graphRevision: 3 } }
    if (variant === "missing correction") mocks.inventory.mockResolvedValue({ marker: { slots: [] }, occupiedSlots: [{ ...slot, correction: undefined }] })
    if (variant === "wrong prior reviewer") mocks.inventory.mockResolvedValue({ marker: { slots: [] }, occupiedSlots: [{ ...slot, reviewerTaskId: "foreign-reviewer" }] })
    await expect(readObjectiveTailorCorrectionChildBinding({ client: { query: vi.fn() } as never, scope, loaded,
      taskId, role: "writer", context: supplied })).resolves.toBeUndefined()
  })

  it("rejects duplicate task membership instead of choosing a slot", async () => {
    const { loaded, correction, slot, context } = fixture()
    mocks.inventory.mockResolvedValue({ marker: { slots: [] }, occupiedSlots: [slot, { ...slot, slotId: "tailor-2" }] })
    await expect(readObjectiveTailorCorrectionChildBinding({ client: { query: vi.fn() } as never, scope, loaded,
      taskId: correction.writerTaskId, role: "writer", context })).resolves.toBeUndefined()
  })
})
