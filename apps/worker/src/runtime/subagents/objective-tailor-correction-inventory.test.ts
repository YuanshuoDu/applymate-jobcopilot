import { describe, expect, it, vi } from "vitest"
import { bindObjectiveTailorWaveCandidateWitness, makeObjectiveTailorWaveCandidateSelection } from "./objective-tailor-wave-witness.js"
import { bindObjectiveTailorCorrectionProof, objectiveTailorCorrectionNodeKeys } from "./objective-tailor-correction-witness.js"
import { readObjectiveTailorCorrectionInventory } from "./objective-tailor-correction-inventory.js"
import type { LoadedGraph } from "./task-graph-pg-state.js"

const mocks = vi.hoisted(() => ({ receipt: vi.fn() }))
vi.mock("../../db/agent-artifact-repo.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../db/agent-artifact-repo.js")>(), findReviewReceiptWithClient: mocks.receipt,
}))
const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
const jobId = "f47ac10b-58cc-4372-a567-0e02b2c3d471"
const sha = (char: string) => `sha256:${char.repeat(64)}`

function fixture(change?: "context" | "owner" | "initial-id" | "dependency" | "version" | "receipt") {
  const selection = makeObjectiveTailorWaveCandidateSelection({ scope, sourceGraphRevision: 1,
    sourceGraphDigest: "a".repeat(64), sourceStatusDigest: "b".repeat(64), analystProofDigest: "c".repeat(64),
    candidate: { jobId, score: 8.5, materialDigest: sha("d") }, sourceAnalystKey: "analyst-node" })!
  const witness = bindObjectiveTailorWaveCandidateWitness(selection, { slotId: "tailor-1", admittedRevision: 2 })!
  const artifactRef = { artifactId: "artifact-1", version: 3, contentHash: sha("e"), sourceDigest: sha("f") }
  const reviewHash = sha("b"), initialWriterId = "initial-writer-task", initialReviewerId = "initial-reviewer-task"
  const proofWriterId = change === "initial-id" ? "foreign-writer" : initialWriterId
  const proof = bindObjectiveTailorCorrectionProof({ graphRevision: 5, slotId: "tailor-1", candidateWitness: witness,
    writerTaskId: proofWriterId, reviewerTaskId: initialReviewerId, artifactRef,
    artifactVersion: { ...artifactRef, artifactType: "cover_letter", taskId: proofWriterId, previousHash: null },
    reviewReceipt: { jobId, ...artifactRef, currentSourceDigest: artifactRef.sourceDigest, status: "needs_revision",
      taskId: initialReviewerId, toolCallId: "review-call-1", reviewHash } })!
  const keys = objectiveTailorCorrectionNodeKeys("tailor-1")!
  const correctionContext = { objectiveTailorCandidateMode: true, selectedJobPreparation: { jobId },
    objectiveTailorCandidateWitness: witness, objectiveTailorCorrectionProof: proof }
  const context = change === "context" ? { ...correctionContext, objectiveTailorCorrectionProof: { ...proof, slotId: "tailor-2" } } : correctionContext
  const row = (id: string, role: string, taskType: string, status: string, value: unknown) => ({ id,
    sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId,
    userId: change === "owner" && role === "writer" ? "foreign" : scope.userId,
    turnRootTaskId: scope.rootTaskId, turnUserId: scope.userId, role, taskType, status, context: value })
  const artifactEnvelope = (role: "writer" | "reviewer") => ({ finalItemId: null, finalText: "", status: "completed",
    stepCount: 1, toolCallCount: 1, structuredResult: { schemaVersion: "agent-harness.v2.subagent.result", role,
      status: "completed", artifactRef, ...(role === "reviewer" ? { reviewStatus: "needs_revision", reviewHash } : {}) } })
  const nodes = [
    { key: "analyst-node", taskId: "analyst-task", templateId: "analyst", dependsOn: [] },
    { key: witness.writerNodeKey, taskId: initialWriterId, templateId: "cover_letter_writer", dependsOn: ["analyst-node"] },
    { key: witness.reviewerNodeKey, taskId: initialReviewerId, templateId: "cover_letter_reviewer", dependsOn: [witness.writerNodeKey] },
    { key: keys.writerNodeKey, taskId: "correction-writer-task", templateId: "cover_letter_writer",
      dependsOn: [change === "dependency" ? "other-reviewer" : witness.reviewerNodeKey] },
    { key: keys.reviewerNodeKey, taskId: "correction-reviewer-task", templateId: "cover_letter_reviewer", dependsOn: [keys.writerNodeKey] },
  ]
  const task = (id: string, role: string, taskType: string, status: string, result: unknown = null) => ({ id, role, taskType, status, result, failureReason: null })
  const graph = { rootTaskId: scope.rootTaskId, item: { id: "graph", revision: 6 }, snapshot: { nodes },
    state: { nodes: nodes.map(node => ({ key: node.key, status: node.taskId.includes("initial-") ? "completed"
      : node.taskId.includes("correction-writer") ? "queued" : node.taskId.includes("correction-reviewer") ? "waiting" : "completed" })) },
    tasks: new Map([
      ["initial-writer-task", task(initialWriterId, "writer", "cover_letter_draft", "completed", artifactEnvelope("writer"))],
      ["initial-reviewer-task", task(initialReviewerId, "reviewer", "cover_letter_review", "completed", artifactEnvelope("reviewer"))],
      ["correction-writer-task", task("correction-writer-task", "writer", "cover_letter_draft", "queued")],
      ["correction-reviewer-task", task("correction-reviewer-task", "reviewer", "cover_letter_review", "waiting")],
    ]) }
  const rows = [row("correction-writer-task", "writer", "cover_letter_draft", "queued", context),
    row("correction-reviewer-task", "reviewer", "cover_letter_review", "waiting", correctionContext)]
  const version = { ...proof.prior.artifactVersion, userId: scope.userId, sessionId: scope.sessionId }
  const client = { query: vi.fn(async (sql: string) => ({ rows: change === "version" || !sql.includes('FROM "agent_artifact_version"') ? [] : [version] })) }
  mocks.receipt.mockResolvedValue({ userId: scope.userId, sessionId: scope.sessionId,
    ...proof.prior.reviewReceipt, ...(change === "receipt" ? { toolCallId: "different-review-call" } : {}) })
  const slot = { slotId: "tailor-1" as const, sourceAnalystNodeKey: "analyst-node", writerNodeKey: witness.writerNodeKey,
    reviewerNodeKey: witness.reviewerNodeKey, correction: keys }
  return { client, loaded: graph as unknown as LoadedGraph, rows, slot, witness, proof, initialWriterId, initialReviewerId }
}

describe("Objective Tailor correction inventory", () => {
  it("reconstructs a closed successor pair and its exact original immutable receipt", async () => {
    const value = fixture(), result = await readObjectiveTailorCorrectionInventory({
      client: value.client as never, scope, loaded: value.loaded, slot: value.slot, witness: value.witness,
      initialWriterTaskId: value.initialWriterId, initialReviewerTaskId: value.initialReviewerId, rows: value.rows,
    })
    expect(result).toEqual({ proof: value.proof, writerTaskId: "correction-writer-task", reviewerTaskId: "correction-reviewer-task" })
    expect(value.client.query).toHaveBeenCalledWith(expect.stringContaining('"artifactType"=\'cover_letter\''), expect.any(Array))
  })

  it.each(["context", "owner", "initial-id", "dependency", "version", "receipt"] as const)(
    "rejects correction inventory with mismatched %s proof", async change => {
      const value = fixture(change)
      await expect(readObjectiveTailorCorrectionInventory({ client: value.client as never, scope, loaded: value.loaded,
        slot: value.slot, witness: value.witness, initialWriterTaskId: value.initialWriterId,
        initialReviewerTaskId: value.initialReviewerId, rows: value.rows })).resolves.toBeUndefined()
    })
})
