import { beforeEach, describe, expect, it, vi } from "vitest"
import { readObjectiveJourneyReadySlot, readObjectiveJourneySlotCandidate, readObjectiveJourneySlotPair } from "./objective-journey-slot-source"
import type { ObjectiveJourneyProofContext } from "./objective-journey-report-source"

const mocks = vi.hoisted(() => ({ pairProof: vi.fn() }))
vi.mock("../broker/objective-application-review-source-proof", async importOriginal => {
  const actual = await importOriginal<typeof import("../broker/objective-application-review-source-proof")>()
  return { ...actual, objectiveApplicationReviewPairProof: mocks.pairProof }
})

const hash = (letter: string) => `sha256:${letter.repeat(64)}`
const proof = { artifactRef: { artifactId: "artifact-corrected", version: 2, contentHash: hash("a"), sourceDigest: hash("b") },
  reviewHash: hash("c"), prior: { writerTaskId: "writer-original-task", reviewerTaskId: "reviewer-original-task",
    artifactRef: { artifactId: "artifact-original", version: 1, contentHash: hash("d"), sourceDigest: hash("e") },
    reviewHash: hash("f"), toolCallId: "review-tool-call" } }

describe("Objective Journey slot source proof", () => {
  beforeEach(() => { mocks.pairProof.mockReset(); mocks.pairProof.mockReturnValue(proof) })

  it("binds the effective corrected Writer and Reviewer pair", () => {
    const context = fixtureContext([slot(1, "job-1", true)])
    const result = readObjectiveJourneyReadySlot(context, 1)

    expect(result).toEqual({ ordinal: 1, jobId: "job-1", writerTaskId: "writer-corrected-task",
      reviewerTaskId: "reviewer-corrected-task", artifactRef: proof.artifactRef, reviewHash: proof.reviewHash,
      prior: proof.prior })
    expect(mocks.pairProof).toHaveBeenCalledTimes(1)
    expect(mocks.pairProof.mock.calls[0]?.[0]).toMatchObject({
      slotOrdinal: 1, graphRevision: 6, jobId: "job-1",
      source: { writerTaskId: "writer-corrected-task", reviewerTaskId: "reviewer-corrected-task",
        artifactId: "artifact-corrected", version: 2, contentHash: hash("a"), sourceDigest: hash("b"), reviewHash: hash("c") },
    })
  })

  it("rejects a Job repeated in another slot before reading either review pair", () => {
    const context = fixtureContext([slot(1, "job-1", false), slot(2, "job-1", false)])
    expect(readObjectiveJourneyReadySlot(context, 1)).toBeNull()
    expect(mocks.pairProof).not.toHaveBeenCalled()
  })

  it("keeps the exact private candidate witness shape", () => {
    const context = fixtureContext([slot(1, "job-1", false)])
    const marker = context.progress.marker.slots[0]!
    const candidate = readObjectiveJourneySlotCandidate(marker, 1, context.graphRevision, context.progress, context.tasks)

    expect(candidate).toEqual({ jobId: "job-1", sourceAnalystKeys: ["analyst-1"], analystProofDigest: "d".repeat(64),
      jobMaterialDigest: hash("e") })
    expect(readObjectiveJourneySlotPair(marker, 1, context.graphRevision, candidate!.jobId, context.progress, context.tasks))
      .toMatchObject({ writerTaskId: "writer-1-task", reviewerTaskId: "reviewer-1-task" })
  })
})

function fixtureContext(slots: ReturnType<typeof slot>[]): ObjectiveJourneyProofContext {
  const graphNodes = slots.flatMap(value => [
    { key: value.sourceAnalystNodeKey, taskId: `task-${value.sourceAnalystNodeKey}`, templateId: "analyst" },
    { key: value.writerNodeKey, taskId: `${value.writerNodeKey}-task`, templateId: "writer" },
    { key: value.reviewerNodeKey, taskId: `${value.reviewerNodeKey}-task`, templateId: "reviewer" },
    ...(value.correction ? [
      { key: value.correction.writerNodeKey, taskId: `${value.correction.writerNodeKey}-task`, templateId: "writer" },
      { key: value.correction.reviewerNodeKey, taskId: `${value.correction.reviewerNodeKey}-task`, templateId: "reviewer" },
    ] : []),
  ])
  const tasks = new Map<string, Record<string, unknown>>()
  for (const node of graphNodes) {
    const writer = node.templateId === "writer"
    const corrected = node.key.includes("corrected")
    const result = writer
      ? { structuredResult: { artifactRef: { artifactId: corrected ? "artifact-corrected" : "artifact-original",
        version: corrected ? 2 : 1, contentHash: corrected ? hash("a") : hash("d"), sourceDigest: corrected ? hash("b") : hash("e") } } }
      : { structuredResult: { reviewHash: corrected ? hash("c") : hash("f") } }
    const candidateSlotIndex = slots.findIndex(value => value.writerNodeKey === node.key)
    tasks.set(node.taskId, { id: node.taskId, result,
      context: writer && candidateSlotIndex >= 0
        ? candidateContext(candidateSlotIndex + 1, slots[candidateSlotIndex]!.jobId) : {} })
  }
  return { graphRevision: 6, progress: { marker: { slots }, nodes: graphNodes }, sidecar: { slots: slots.map(() => ({ status: "ready" })) }, tasks } as unknown as ObjectiveJourneyProofContext
}

function slot(ordinal: number, jobId: string, corrected: boolean) {
  return { slotId: `tailor-${ordinal}`, sourceAnalystNodeKey: `analyst-${ordinal}`,
    writerNodeKey: `writer-${ordinal}`, reviewerNodeKey: `reviewer-${ordinal}`,
    ...(corrected ? { correction: { writerNodeKey: "writer-corrected", reviewerNodeKey: "reviewer-corrected" } } : {}), jobId }
}

function candidateContext(slotOrdinal: number, jobId: string) {
  return { objectiveTailorCandidateMode: true, selectedJobPreparation: { jobId },
    objectiveTailorCandidateWitness: { schemaVersion: "agent-harness.v2.objective-tailor-wave-witness.v1",
      candidateRef: `otc2_${"a".repeat(64)}`, sourceGraphRevision: 4, sourceGraphDigest: "b".repeat(64),
      sourceStatusDigest: "c".repeat(64), analystProofDigest: "d".repeat(64),
      candidate: { jobId, score: 9, materialDigest: hash("e") }, sourceAnalystKeys: [`analyst-${slotOrdinal}`],
      slotId: `tailor-${slotOrdinal}`, writerNodeKey: `writer-${slotOrdinal}`, reviewerNodeKey: `reviewer-${slotOrdinal}`,
      admittedRevision: 5 } }
}
