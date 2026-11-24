import { createHash } from "node:crypto"
import { buildObjectiveApplicationReviewMemberProof, buildObjectiveApplicationResumeWitness, canonicalJson } from "@jobcopilot/shared"
import { describe, expect, it } from "vitest"
import { canonicalTaskGraphSourceKey } from "../session/final-task-graph-source-detail"
import { parseObjectiveTailorProgressSnapshot } from "../session/objective-tailor-progress-snapshot"
import {
  objectiveApplicationReviewInputValid,
  objectiveApplicationReviewPairProof,
  parseObjectiveApplicationReviewArtifactHead,
  validObjectiveApplicationReviewContent,
  validObjectiveApplicationSourceManifest,
} from "./objective-application-review-source-proof"
import type { ObjectiveApprovalSetSourceInput } from "./objective-application-approval-set-decision"

const userId = "user-1", jobId = "job-1", sourceTurnId = "source-turn-1", rootTaskId = "source-root-1"
const graphItemId = "task-graph-source", finalItemId = "source-final"
const contentHash = prefixed("a"), sourceDigest = prefixed("b"), priorHash = prefixed("c")
const reviewHash = prefixed("d"), oldReviewHash = prefixed("e"), jobDigest = prefixed("f")
const initialWriterKey = "objective-tailor-wave-writer-tailor-1"
const initialReviewerKey = "objective-tailor-wave-reviewer-tailor-1"
const correctionWriterKey = "objective-tailor-wave-correction-writer-tailor-1"
const correctionReviewerKey = "objective-tailor-wave-correction-reviewer-tailor-1"
const initialWriterId = "writer-task-initial", initialReviewerId = "reviewer-task-initial"
const writerId = "writer-task-successor", reviewerId = "reviewer-task-successor"
const artifactId = "artifact-cover-letter"

describe("objective application review source proof", () => {
  it("accepts the exact effective initial pair while keeping candidate and whole-source digests distinct", () => {
    const fixture = makePair(false)
    expect(fixture.snapshot.nodes.find(node => node.key === initialWriterKey)?.taskId).toBe(initialWriterId)
    expect(initialWriterKey).not.toBe(writerId)
    expect(fixture.witness.candidate.materialDigest).toBe(jobDigest)
    expect(fixture.source.sourceDigest).toBe(sourceDigest)
    expect(objectiveApplicationReviewPairProof(fixture.input)).toMatchObject({ artifactRef: fixture.sourceArtifact, reviewHash })
  })

  it("accepts a corrected effective pair only with the exact initial needs_revision lineage", () => {
    const fixture = makePair(true)
    const result = objectiveApplicationReviewPairProof(fixture.input)
    expect(result).toMatchObject({ artifactRef: fixture.sourceArtifact, reviewHash, prior: {
      writerTaskId: initialWriterId, reviewerTaskId: initialReviewerId, artifactRef: fixture.priorArtifact, reviewHash: oldReviewHash,
    } })
    expect(result?.prior?.writerTaskId).not.toBe(initialWriterKey)
  })

  it("rejects a mismatched effective task, job, or correction receipt", () => {
    const initial = makePair(false)
    expect(objectiveApplicationReviewPairProof({ ...initial.input, source: { ...initial.source, writerTaskId: "foreign-writer-id" } })).toBeUndefined()
    const corrected = makePair(true)
    const wrongJobContext = { ...corrected.input, writerTask: { ...corrected.input.writerTask,
      context: { ...objectRecord(corrected.input.writerTask.context), selectedJobPreparation: { jobId: "job-other" } } } }
    expect(objectiveApplicationReviewPairProof(wrongJobContext)).toBeUndefined()
    const wrongPrior = structuredClone(corrected.input)
    const context = objectRecord(wrongPrior.writerTask.context)
    const correction = objectRecord(context.objectiveTailorCorrectionProof)
    const prior = objectRecord(correction.prior)
    const reviewReceipt = objectRecord(prior.reviewReceipt)
    wrongPrior.writerTask.context = { ...context, objectiveTailorCorrectionProof: { ...correction,
      prior: { ...prior, reviewReceipt: { ...reviewReceipt, taskId: "foreign-reviewer" } } } }
    expect(objectiveApplicationReviewPairProof(wrongPrior)).toBeUndefined()
  })

  it("binds the review input and source manifest, and parses only prefixed artifact head hashes", () => {
    const fixture = makePair(false)
    expect(objectiveApplicationReviewInputValid(fixture.sourceInput, fixture.parsedProof)).toBe(true)
    expect(validObjectiveApplicationReviewContent([{ type: "text", text: "Review the selected verified materials. This does not authorize an application or submission." }])).toBe(true)
    expect(validObjectiveApplicationReviewContent({ type: "text", text: "Review the selected verified materials. This does not authorize an application or submission." })).toBe(false)
    expect(validObjectiveApplicationReviewContent([{ type: "text", text: "untrusted" }])).toBe(false)
    const manifest = { schemaVersion: "agent-harness.v2.task-graph-sources.v1", graphRevision: 4, sources: [
      { sourceKey: canonicalTaskGraphSourceKey(finalItemId, 4, 0), nodeIndex: 0, role: "scout", taskStatus: "completed", resultState: "valid", roleResultStatus: "completed" },
      { sourceKey: canonicalTaskGraphSourceKey(finalItemId, 4, 1), nodeIndex: 1, role: "analyst", taskStatus: "completed", resultState: "valid", roleResultStatus: "completed" },
    ] } as const
    expect(validObjectiveApplicationSourceManifest(manifest, finalItemId, fixture.snapshot, fixture.tasks)).toBe(true)
    expect(validObjectiveApplicationSourceManifest({ ...manifest, graphRevision: 3 }, finalItemId, fixture.snapshot, fixture.tasks)).toBe(false)
    expect(parseObjectiveApplicationReviewArtifactHead({ id: artifactId, version: 2, hash: contentHash })).toEqual({ artifactId, version: 2, hash: contentHash })
    expect(parseObjectiveApplicationReviewArtifactHead({ id: artifactId, version: 2, hash: contentHash.slice(7) })).toBeUndefined()
  })
})

function makePair(corrected: boolean) {
  const witness = { schemaVersion: "agent-harness.v2.objective-tailor-wave-witness.v1", candidateRef: `otc2_${"1".repeat(64)}`,
    sourceGraphRevision: 1, sourceGraphDigest: "2".repeat(64), sourceStatusDigest: "3".repeat(64), analystProofDigest: "4".repeat(64),
    candidate: { jobId, score: 8, materialDigest: jobDigest }, sourceAnalystKeys: ["source-analyst-key"], slotId: "tailor-1",
    writerNodeKey: initialWriterKey, reviewerNodeKey: initialReviewerKey, admittedRevision: 2 }
  const priorArtifact = { artifactId, version: 1, contentHash: priorHash, sourceDigest }
  const sourceArtifact = { artifactId, version: corrected ? 2 : 1, contentHash, sourceDigest }
  const correctionProof = { schemaVersion: "agent-harness.v2.objective-tailor-correction-proof.v1", graphRevision: 2, admittedRevision: 3,
    slotId: "tailor-1", candidateWitness: witness, writerNodeKey: correctionWriterKey, reviewerNodeKey: correctionReviewerKey,
    prior: { writerTaskId: initialWriterId, reviewerTaskId: initialReviewerId, artifactRef: priorArtifact,
      artifactVersion: { artifactId, artifactType: "cover_letter", taskId: initialWriterId, version: 1,
        contentHash: priorHash, sourceDigest, previousHash: null },
      reviewReceipt: { jobId, artifactId, version: 1, contentHash: priorHash, sourceDigest, currentSourceDigest: sourceDigest,
        status: "needs_revision", taskId: initialReviewerId, toolCallId: "initial-review-call", reviewHash: oldReviewHash } } }
  const baseContext = { objectiveTailorCandidateMode: true, selectedJobPreparation: { jobId }, objectiveTailorCandidateWitness: witness }
  const currentContext = corrected ? { ...baseContext, objectiveTailorCorrectionProof: correctionProof } : baseContext
  const initialArtifact = corrected ? priorArtifact : sourceArtifact
  const initialReviewStatus = corrected ? "needs_revision" : "passed"
  const initialReviewHash = corrected ? oldReviewHash : reviewHash
  const graphNodes = [sourceNode("scout", "source-scout-key", "scout-task-id", []),
    sourceNode("analyst", "source-analyst-key", "analyst-task-id", ["source-scout-key"]),
    templateNode(initialWriterKey, initialWriterId, "cover_letter_writer", ["source-analyst-key"]),
    templateNode(initialReviewerKey, initialReviewerId, "cover_letter_reviewer", [initialWriterKey]),
    ...(corrected ? [templateNode(correctionWriterKey, writerId, "cover_letter_writer", [initialReviewerKey]),
      templateNode(correctionReviewerKey, reviewerId, "cover_letter_reviewer", [correctionWriterKey])] : [])]
  const rawSnapshot = { schemaVersion: "agent-harness.v2.task-graph", nodes: graphNodes,
    objectiveTailor: { schemaVersion: "agent-harness.v2.objective-tailor-graph.v1", sourceNodeCount: 2,
      slots: [{ slotId: "tailor-1", sourceAnalystNodeKey: "source-analyst-key", writerNodeKey: initialWriterKey,
        reviewerNodeKey: initialReviewerKey, ...(corrected ? { correction: { writerNodeKey: correctionWriterKey, reviewerNodeKey: correctionReviewerKey } } : {}) }] } }
  const snapshot = parseObjectiveTailorProgressSnapshot(rawSnapshot)!
  const currentWriterId = corrected ? writerId : initialWriterId, currentReviewerId = corrected ? reviewerId : initialReviewerId
  const tasks = new Map<string, Record<string, unknown>>([
    ["scout-task-id", task("scout-task-id", "scout", "completed", typedSourceResult("scout", "candidate-count"))],
    ["analyst-task-id", task("analyst-task-id", "analyst", "completed", typedSourceResult("analyst", "finding-count"))],
    [initialWriterId, task(initialWriterId, "writer", "completed", roleResult("writer", { artifactRef: initialArtifact }), baseContext)],
    [initialReviewerId, task(initialReviewerId, "reviewer", "completed", roleResult("reviewer", {
      artifactRef: initialArtifact, reviewStatus: initialReviewStatus, reviewHash: initialReviewHash }), baseContext)],
    ...(corrected ? [[writerId, task(writerId, "writer", "completed", roleResult("writer", { artifactRef: sourceArtifact }), currentContext)],
      [reviewerId, task(reviewerId, "reviewer", "completed", roleResult("reviewer", {
        artifactRef: sourceArtifact, reviewStatus: "passed", reviewHash }), currentContext)]] as const : []),
  ])
  const source = { jobId, slotOrdinal: 1, writerTaskId: currentWriterId, reviewerTaskId: currentReviewerId,
    reviewerToolCallId: "review-call-current", artifactId, version: sourceArtifact.version,
    contentHash: sourceArtifact.contentHash, sourceDigest, reviewHash }
  const resumeWitness = buildObjectiveApplicationResumeWitness({ userId, jobId, resumeId: "resume-1",
    finalResumeAssignmentRevision: 2, materialRevision: 5, material: { name: "Adapted", content: { skills: ["TS"] },
      templateId: null, templateOptions: null, kind: "adapted", targetJobId: jobId, parentResumeId: null, basicsDetached: false } })!
  const parsedProof = buildObjectiveApplicationReviewMemberProof({ source: { ...source, sourceTurnId, rootTaskId,
    graphItemId, graphRevision: 4, finalItemId }, resumeWitness })!
  const sourceInput: ObjectiveApprovalSetSourceInput = { setId: "review-set", intentHash: "a".repeat(64), sourceTurnId,
    slotOrdinal: 1, member: { approvalId: "approval-1", taskId: "application-task-1", userId, sessionId: "session-1",
      turnId: "review-turn-1", jobId, toolCallId: "review-call-1", scopeHash: "b".repeat(64), revision: 0,
      expiresAt: new Date("2099-01-01T00:00:00.000Z"), proof: parsedProof, resumeWitness } }
  return { witness, sourceArtifact, priorArtifact, snapshot, tasks, source, parsedProof, sourceInput,
    input: { snapshot, slotOrdinal: 1, graphRevision: 4, jobId, source, writerTask: tasks.get(currentWriterId)!,
      reviewerTask: tasks.get(currentReviewerId)!, tasks } }
}

function sourceNode(templateId: "scout" | "analyst", key: string, taskId: string, dependsOn: string[]) {
  return { key, taskId, templateId, goal: "Produce bounded source evidence", successCriteria: ["Return typed evidence"], dependsOn,
    depth: templateId === "scout" ? 1 : 2, verificationDisposition: "typed", verification: { schemaVersion: "agent-harness.v2.task-graph-verification.v1",
      role: templateId, criteria: [{ id: templateId === "scout" ? "candidate-count" : "finding-count",
        check: { kind: templateId === "scout" ? "candidate_count_gte" : "finding_count_gte", minimum: 1 } }] } }
}
function templateNode(key: string, taskId: string, templateId: "cover_letter_writer" | "cover_letter_reviewer", dependsOn: string[]) {
  return { key, taskId, templateId, goal: "Complete the selected job draft step", successCriteria: ["Persist an exact task result"],
    dependsOn, depth: templateId === "cover_letter_writer" ? 3 : 4, verificationDisposition: "specialized" }
}
function task(id: string, role: string, status: string, result: unknown, context: unknown = {}) { return { id, role, status, result, context } }
function roleResult(role: string, result: Record<string, unknown>) {
  return { finalItemId: null, finalText: "completed", status: "completed", stepCount: 1, toolCallCount: 1,
    structuredResult: { schemaVersion: "agent-harness.v2.subagent.result", role, status: "completed", ...result } }
}
function typedSourceResult(role: "scout" | "analyst", criterionId: string) {
  const envelope = roleResult(role, {}), resultDigest = createHash("sha256").update(canonicalJson(envelope.structuredResult)).digest("hex")
  return { ...envelope, taskGraphVerificationReport: { verifierVersion: "agent-harness.v2.task-graph-verifier.v1", status: "passed",
    reasonCode: "criteria_met", criteria: [{ criterionId, status: "passed", reasonCode: "criteria_met" }],
    evidenceDigest: "a".repeat(64), resultDigest } }
}
function objectRecord(value: unknown): Record<string, unknown> { return value as Record<string, unknown> }
function prefixed(character: string) { return `sha256:${character.repeat(64)}` }
