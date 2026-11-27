import { describe, expect, it } from "vitest"
import { bindObjectiveTailorCorrectionProof, objectiveTailorCorrectionNodeKeys } from "./subagents/objective-tailor-correction-witness.js"
import { bindObjectiveTailorWaveCandidateWitness, makeObjectiveTailorWaveCandidateSelection } from "./subagents/objective-tailor-wave-witness.js"
import { projectObjectiveTailorWaveOutcomeObservation } from "./objective-tailor-wave-outcome-projection.js"
import type { ObjectiveTailorWaveCompletionResult } from "./canonical-objective-tailor-wave-completion.js"

const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
const hash = `sha256:${"a".repeat(64)}`
const statuses = ["ready", "needs_revision", "rejected", "stale", "failed", "pending"] as const

function fixture(includePending = true) {
  const candidates = statuses.map((_, index) => {
    const selection = makeObjectiveTailorWaveCandidateSelection({ scope, sourceGraphRevision: 1,
      sourceGraphDigest: "b".repeat(64), sourceStatusDigest: "c".repeat(64), analystProofDigest: "d".repeat(64),
      candidate: { jobId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, score: 8,
        materialDigest: hash }, sourceAnalystKey: "analyst-1" })!
    return bindObjectiveTailorWaveCandidateWitness(selection, { slotId: `tailor-${index + 1}`, admittedRevision: 2 })!
  })
  const correctionKeys = objectiveTailorCorrectionNodeKeys("tailor-1")!
  const slots = candidates.map((candidate, index) => ({ slotId: candidate.slotId, sourceAnalystNodeKey: "analyst-1",
    writerNodeKey: candidate.writerNodeKey, reviewerNodeKey: candidate.reviewerNodeKey,
    ...(index === 0 ? { correction: correctionKeys } : {}) }))
  const nodes = [
    { key: "scout-1", taskId: "scout-task", templateId: "scout", verificationDisposition: "typed", dependsOn: [] },
    { key: "analyst-1", taskId: "analyst-task", templateId: "analyst", verificationDisposition: "typed", dependsOn: ["scout-1"] },
    ...candidates.flatMap((candidate, index) => [
      { key: candidate.writerNodeKey, taskId: `writer-${index + 1}`, templateId: "cover_letter_writer", dependsOn: ["analyst-1"] },
      { key: candidate.reviewerNodeKey, taskId: `reviewer-${index + 1}`, templateId: "cover_letter_reviewer", dependsOn: [candidate.writerNodeKey] },
      ...(index === 0 ? [
        { key: correctionKeys.writerNodeKey, taskId: "writer-correction-1", templateId: "cover_letter_writer", dependsOn: [candidate.reviewerNodeKey] },
        { key: correctionKeys.reviewerNodeKey, taskId: "reviewer-correction-1", templateId: "cover_letter_reviewer", dependsOn: [correctionKeys.writerNodeKey] },
      ] : []),
    ]),
  ]
  const marker = { schemaVersion: "agent-harness.v2.objective-tailor-graph.v1", sourceNodeCount: 2, slots }
  const correctionProof = bindObjectiveTailorCorrectionProof({ graphRevision: 5, slotId: "tailor-1", candidateWitness: candidates[0],
    writerTaskId: "writer-1", reviewerTaskId: "reviewer-1",
    artifactRef: { artifactId: "artifact-1", version: 1, contentHash: hash, sourceDigest: hash },
    artifactVersion: { artifactId: "artifact-1", artifactType: "cover_letter", taskId: "writer-1", version: 1,
      contentHash: hash, sourceDigest: hash, previousHash: null },
    reviewReceipt: { jobId: candidates[0]!.candidate.jobId, artifactId: "artifact-1", version: 1, contentHash: hash,
      sourceDigest: hash, currentSourceDigest: hash, status: "needs_revision", taskId: "reviewer-1", toolCallId: "review-1", reviewHash: hash } })!
  const outcomes = candidates.map((candidate, index) => ({ slotId: candidate.slotId, jobId: candidate.candidate.jobId,
    writerTaskId: index === 0 ? "writer-correction-1" : `writer-${index + 1}`,
    reviewerTaskId: index === 0 ? "reviewer-correction-1" : `reviewer-${index + 1}`,
    candidateWitness: candidate, status: includePending || index !== 5 ? statuses[index] : "failed",
    artifactRef: { artifactId: `private-artifact-${index + 1}` }, reviewReceipt: { toolCallId: `private-call-${index + 1}` },
    ...(index === 0 ? { correction: { proof: correctionProof, writerTaskId: "writer-correction-1", reviewerTaskId: "reviewer-correction-1" } } : {}),
  }))
  const result: ObjectiveTailorWaveCompletionResult = includePending
    ? { status: "pending", outcomes: outcomes as never }
    : { status: "ready", outcomes: outcomes as never,
      witness: { graphRevision: 6, graphDigest: "e".repeat(64), marker, sourceGraphRevision: 1, sourceGraphDigest: "b".repeat(64),
        sourceStatusDigest: "c".repeat(64), outcomes } as never }
  return { marker, nodes, candidates, outcomes, correctionProof, result }
}

describe("objective-tailor-wave-outcome-projection", () => {
  it("projects only ordered slot outcomes for initial and corrected effective pairs", () => {
    const value = fixture()
    const observed = projectObjectiveTailorWaveOutcomeObservation({ graphRevision: 6, marker: value.marker, nodes: value.nodes, result: value.result })

    expect(observed).toEqual({ schemaVersion: "agent-harness.v2.objective-tailor-wave-outcomes.v1", graphRevision: 6,
      slots: statuses.map((status, index) => ({ slotId: `tailor-${index + 1}`,
        effectivePair: index === 0 ? "correction" : "initial", status })) })
    expect(JSON.stringify(observed)).not.toMatch(/private|artifact|reviewer-|job-|hash|call/i)
  })

  it("binds completed observations to the exact revision and matching witness", () => {
    const value = fixture(false)
    expect(projectObjectiveTailorWaveOutcomeObservation({ graphRevision: 6, marker: value.marker, nodes: value.nodes, result: value.result })).toBeDefined()
    expect(projectObjectiveTailorWaveOutcomeObservation({ graphRevision: 7, marker: value.marker, nodes: value.nodes, result: value.result })).toBeUndefined()
    const wrongMarker = { ...value.marker, sourceNodeCount: 3 }
    expect(projectObjectiveTailorWaveOutcomeObservation({ graphRevision: 6, marker: wrongMarker, nodes: value.nodes, result: value.result })).toBeUndefined()
    const wrongCandidate = { ...value.outcomes[1], candidateWitness: { ...value.candidates[1], sourceAnalystKeys: ["foreign-analyst"] } }
    expect(projectObjectiveTailorWaveOutcomeObservation({ graphRevision: 6, marker: value.marker, nodes: value.nodes,
      result: { status: "ready", outcomes: [value.outcomes[0], wrongCandidate, ...value.outcomes.slice(2)], witness: value.result.status === "ready" ? value.result.witness : undefined } as never })).toBeUndefined()
  })

  it("rejects incomplete, duplicate, out-of-order and blocked outcomes", () => {
    const value = fixture()
    const outcomes = value.outcomes
    for (const broken of [outcomes.slice(1), [outcomes[1], outcomes[0], ...outcomes.slice(2)],
      [...outcomes.slice(0, 5), outcomes[4]]]) {
      expect(projectObjectiveTailorWaveOutcomeObservation({ graphRevision: 6, marker: value.marker, nodes: value.nodes,
        result: { status: "pending", outcomes: broken } as never })).toBeUndefined()
    }
    expect(projectObjectiveTailorWaveOutcomeObservation({ graphRevision: 6, marker: value.marker, nodes: value.nodes,
      result: { status: "blocked", outcomes } as never })).toBeUndefined()
    expect(projectObjectiveTailorWaveOutcomeObservation({ graphRevision: 6, marker: value.marker, nodes: value.nodes,
      result: { status: "absent" } as never })).toBeUndefined()
  })

  it("rejects mismatched correction provenance and inconsistent pending state", () => {
    const value = fixture()
    const first = value.outcomes[0]! as { correction: { writerTaskId: string; reviewerTaskId: string } }
    const badCorrection = { ...value.outcomes[0], correction: { ...first.correction,
      proof: { ...value.correctionProof, reviewerNodeKey: "foreign-reviewer" } } }
    const outcomes = [badCorrection, ...value.outcomes.slice(1)]
    expect(projectObjectiveTailorWaveOutcomeObservation({ graphRevision: 6, marker: value.marker, nodes: value.nodes,
      result: { status: "pending", outcomes } as never })).toBeUndefined()
    const noPending = value.outcomes.map(row => ({ ...row, status: "failed" }))
    expect(projectObjectiveTailorWaveOutcomeObservation({ graphRevision: 6, marker: value.marker, nodes: value.nodes,
      result: { status: "pending", outcomes: noPending } as never })).toBeUndefined()
  })
})
