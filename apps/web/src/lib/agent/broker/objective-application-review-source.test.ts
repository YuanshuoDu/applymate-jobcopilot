import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_SCHEMA, objectiveApplicationApprovalSetItemId } from "@jobcopilot/agent-protocol"
import { buildObjectiveApplicationReviewMemberProof, buildObjectiveApplicationResumeWitness, canonicalJson } from "@jobcopilot/shared"
import { canonicalTaskGraphItemId, canonicalTaskGraphSourceKey } from "../session/final-task-graph-source-detail"
import { verifyObjectiveApplicationReviewSource } from "./objective-application-review-source"
import type { ObjectiveApprovalSetSourceInput } from "./objective-application-approval-set-decision"

const material = vi.hoisted(() => ({ sourceDigest: `sha256:${"b".repeat(64)}` }))
vi.mock("@jobcopilot/shared", async importOriginal => {
  const actual = await importOriginal<typeof import("@jobcopilot/shared")>()
  return { ...actual, readAgentSelectedJobMaterial: vi.fn(async () => ({ preparation: { sourceDigest: material.sourceDigest } })) }
})

const userId = "user-1", sessionId = "session-1", reviewTurnId = "review-turn", sourceTurnId = "source-turn"
const sourceRootId = "source-root", reviewRootId = "review-root", jobId = "job-1", finalItemId = "source-final"
const artifactId = "cover-letter-artifact", writerTaskId = "writer-task-id", reviewerTaskId = "reviewer-task-id"
const sourceDigest = material.sourceDigest, contentHash = `sha256:${"a".repeat(64)}`, reviewHash = `sha256:${"c".repeat(64)}`
const candidateDigest = `sha256:${"d".repeat(64)}`, revision = 9
const graphItemId = canonicalTaskGraphItemId(sourceRootId)
const setId = `objective-review-${createHash("sha256").update(`objective-application-review-set.v1\0${sessionId}\0${reviewTurnId}`).digest("hex").slice(0, 40)}`
const approvalId = "approval-1", toolCallId = "review-call-1"

beforeEach(() => { material.sourceDigest = sourceDigest })

describe("verifyObjectiveApplicationReviewSource", () => {
  it("rechecks the completed source, effective pair, material, and prefixed current artifact head", async () => {
    const { tx, input } = fixture()
    await expect(verifyObjectiveApplicationReviewSource(tx as never, input)).resolves.toBe("current")
  })

  it("revalidates an approved slot only after the review Turn and grouped Wait are completed", async () => {
    const completed = fixture({ completedReview: true })
    await expect(verifyObjectiveApplicationReviewSource(completed.tx as never, completed.input, "completed_review"))
      .resolves.toBe("current")
    const pending = fixture()
    await expect(verifyObjectiveApplicationReviewSource(pending.tx as never, pending.input, "completed_review"))
      .rejects.toThrow()
  })

  it("marks changed selected material or exact current head as stale", async () => {
    const { tx, input } = fixture()
    material.sourceDigest = `sha256:${"f".repeat(64)}`
    await expect(verifyObjectiveApplicationReviewSource(tx as never, input)).resolves.toBe("stale")
    const second = fixture({ headVersion: 2 })
    material.sourceDigest = sourceDigest
    await expect(verifyObjectiveApplicationReviewSource(second.tx as never, second.input)).resolves.toBe("stale")
  })

  it("fails closed when the persisted review input does not use the exact user-issued intent", async () => {
    const { tx, input } = fixture({ content: [{ type: "text", text: "different request" }] })
    await expect(verifyObjectiveApplicationReviewSource(tx as never, input)).rejects.toThrow()
  })
})

function fixture(options: { headVersion?: number; content?: unknown; completedReview?: boolean } = {}) {
  const witness = { schemaVersion: "agent-harness.v2.objective-tailor-wave-witness.v1", candidateRef: `otc2_${"1".repeat(64)}`,
    sourceGraphRevision: 2, sourceGraphDigest: "2".repeat(64), sourceStatusDigest: "3".repeat(64), analystProofDigest: "4".repeat(64),
    candidate: { jobId, score: 8, materialDigest: candidateDigest }, sourceAnalystKeys: ["analyst-node-key"], slotId: "tailor-1",
    writerNodeKey: "objective-tailor-wave-writer-tailor-1", reviewerNodeKey: "objective-tailor-wave-reviewer-tailor-1", admittedRevision: 3 }
  const artifactRef = { artifactId, version: 1, contentHash, sourceDigest }
  const context = { objectiveTailorCandidateMode: true, selectedJobPreparation: { jobId }, objectiveTailorCandidateWitness: witness }
  const nodes = [sourceNode("scout", "scout-node-key", "scout-task-id", []),
    sourceNode("analyst", "analyst-node-key", "analyst-task-id", ["scout-node-key"]),
    writerNode(witness.writerNodeKey, writerTaskId, "cover_letter_writer", ["analyst-node-key"]),
    writerNode(witness.reviewerNodeKey, reviewerTaskId, "cover_letter_reviewer", [witness.writerNodeKey])]
  const graphContent = { schemaVersion: "agent-harness.v2.task-graph", nodes,
    objectiveTailor: { schemaVersion: "agent-harness.v2.objective-tailor-graph.v1", sourceNodeCount: 2,
      slots: [{ slotId: "tailor-1", sourceAnalystNodeKey: "analyst-node-key", writerNodeKey: witness.writerNodeKey,
        reviewerNodeKey: witness.reviewerNodeKey }] } }
  const selection = { schema: "agent-harness.v2.objective-application-review-intent.v1", sourceTurnId,
    rootTaskId: sourceRootId, graphItemId, graphRevision: revision, slotOrdinals: [1] }
  const intentHash = createHash("sha256").update(canonicalJson(selection)).digest("hex")
  const resumeWitness = buildObjectiveApplicationResumeWitness({ userId, jobId, resumeId: "resume-1",
    finalResumeAssignmentRevision: 2, materialRevision: 5, material: { name: "Adapted", content: { skills: ["TS"] },
      templateId: null, templateOptions: null, kind: "adapted", targetJobId: jobId, parentResumeId: null, basicsDetached: false } })!
  const proof = buildObjectiveApplicationReviewMemberProof({ source: { jobId, sourceTurnId, rootTaskId: sourceRootId,
    graphItemId, graphRevision: revision, finalItemId, slotOrdinal: 1, writerTaskId, reviewerTaskId,
    reviewerToolCallId: toolCallId, reviewHash, artifactId, version: 1, contentHash, sourceDigest }, resumeWitness })!
  const input: ObjectiveApprovalSetSourceInput = { setId, intentHash, sourceTurnId, slotOrdinal: 1,
    member: { approvalId, taskId: "application-task", userId, sessionId, turnId: reviewTurnId, jobId, toolCallId,
      scopeHash: "a".repeat(64), revision: 0, expiresAt: new Date("2099-01-01T00:00:00.000Z"), proof: proof!, resumeWitness } }
  const itemContent = { schema: "objective-application-approval-set.v1", waitKind: "approval_set", setId, sourceTurnId,
    intentHash, expiresAt: "2099-01-01T00:00:00.000Z", members: [{ slotOrdinal: 1, approvalId }] }
  const sourceResult = (role: "scout" | "analyst") => {
    const structuredResult = { schemaVersion: "agent-harness.v2.subagent.result", role, status: "completed" }
    return { finalItemId: null, finalText: "typed evidence", status: "completed", stepCount: 1, toolCallCount: 1, structuredResult,
      taskGraphVerificationReport: { verifierVersion: "agent-harness.v2.task-graph-verifier.v1", status: "passed", reasonCode: "criteria_met",
        criteria: [{ criterionId: role === "scout" ? "candidate-count" : "finding-count", status: "passed", reasonCode: "criteria_met" }],
        evidenceDigest: "a".repeat(64), resultDigest: createHash("sha256").update(canonicalJson(structuredResult)).digest("hex") } }
  }
  const writerResult = { finalItemId: null, finalText: "Draft", status: "completed", stepCount: 1, toolCallCount: 1,
    structuredResult: { schemaVersion: "agent-harness.v2.subagent.result", role: "writer", status: "completed", artifactRef } }
  const reviewerResult = { finalItemId: null, finalText: "Passed", status: "completed", stepCount: 1, toolCallCount: 1,
    structuredResult: { schemaVersion: "agent-harness.v2.subagent.result", role: "reviewer", status: "completed", artifactRef,
      reviewHash, reviewStatus: "passed" } }
  const tasks = [
    task(sourceRootId, null, "orchestrator", "root", { status: "completed", finalItemId }),
    task("scout-task-id", sourceRootId, "scout", "job_discovery", sourceResult("scout")),
    task("analyst-task-id", sourceRootId, "analyst", "job_analysis", sourceResult("analyst")),
    task(writerTaskId, sourceRootId, "writer", "cover_letter_draft", writerResult, context),
    task(reviewerTaskId, sourceRootId, "reviewer", "cover_letter_review", reviewerResult, context),
  ]
  const manifest = { schemaVersion: "agent-harness.v2.task-graph-sources.v1", graphRevision: revision, sources: [
    { sourceKey: canonicalTaskGraphSourceKey(finalItemId, revision, 0), nodeIndex: 0, role: "scout", taskStatus: "completed", resultState: "valid", roleResultStatus: "completed" },
    { sourceKey: canonicalTaskGraphSourceKey(finalItemId, revision, 1), nodeIndex: 1, role: "analyst", taskStatus: "completed", resultState: "valid", roleResultStatus: "completed" },
  ] }
  const finalContent = { text: "Done", final: { schemaVersion: "agent-harness.v2.final", response: "Done" }, taskGraphSources: manifest,
    objectiveTailorFinalOutcomes: { schemaVersion: OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_SCHEMA, slots: [{ ordinal: 1, status: "ready" }] } }
  const results: unknown[][] = [
    [{ id: objectiveApplicationApprovalSetItemId(setId), type: "approval_request", status: options.completedReview ? "completed" : "started", phase: "commentary", revision: options.completedReview ? 1 : 0,
      stepId: null, taskId: null, content: itemContent }],
    [{ id: sourceTurnId, rootTaskId: sourceRootId, status: "completed", source: "user", executionMode: "canonical_task_graph",
      rootId: sourceRootId, rootStatus: "completed", rootRole: "orchestrator", rootTaskType: "root", depth: 0,
      result: { status: "completed", finalItemId }, sessionStatus: "active" }],
    [{ id: graphItemId, revision, content: graphContent }],
    tasks.map(value => ({ ...value, sessionId, turnId: sourceTurnId, rootTaskId: sourceRootId, userId, turnUserId: userId, turnRootTaskId: sourceRootId })),
    [{ id: "turn-completed-event", itemId: finalItemId, taskId: sourceRootId, actor: "orchestrator", type: "turn.completed",
      idempotencyKey: `turn:${sourceTurnId}:event:turn-completed`, payload: { turnId: sourceTurnId, taskId: sourceRootId, finalItemId } }],
    [{ id: finalItemId, sessionId, turnId: sourceTurnId, taskId: sourceRootId, type: "agent_message", status: "completed", phase: "final_answer", content: finalContent }],
    [{ id: artifactId, version: options.headVersion ?? 1, hash: contentHash }],
    [{ artifactId, version: 1, artifactType: "cover_letter", taskId: writerTaskId, contentHash, sourceDigest, previousHash: null }],
    [{ artifactId, version: 1, contentHash, sourceDigest, currentSourceDigest: sourceDigest, status: "passed", taskId: reviewerTaskId,
      toolCallId, reviewHash }],
  ]
  const tx = {
    agentTurn: { findFirst: vi.fn(async () => ({ id: reviewTurnId, status: options.completedReview ? "completed" : "waiting_for_approval", source: "user",
      executionMode: "canonical_task_graph", rootTaskId: reviewRootId, input: { clientMessageId: "review-command",
        goal: "Review the selected completed Objective materials for application preparation.",
        content: options.content ?? [{ type: "text", text: "Review the selected verified materials. This does not authorize an application or submission." }],
        intent: { kind: "objective_application_review", version: 1, selection } } })) },
    $queryRaw: vi.fn(async () => results.shift() ?? []),
    $queryRawUnsafe: vi.fn(async () => []),
  }
  return { tx, input }
}

function task(id: string, parentTaskId: string | null, role: string, taskType: string, result: unknown, context: unknown = {}) {
  return { id, parentTaskId, role, taskType, status: "completed", result, context }
}
function sourceNode(templateId: "scout" | "analyst", key: string, taskId: string, dependsOn: string[]) {
  return { key, taskId, templateId, goal: "Produce bounded source evidence", successCriteria: ["Return typed evidence"], dependsOn,
    depth: templateId === "scout" ? 1 : 2, verificationDisposition: "typed", verification: { schemaVersion: "agent-harness.v2.task-graph-verification.v1",
      role: templateId, criteria: [{ id: templateId === "scout" ? "candidate-count" : "finding-count",
        check: { kind: templateId === "scout" ? "candidate_count_gte" : "finding_count_gte", minimum: 1 } }] } }
}
function writerNode(key: string, taskId: string, templateId: "cover_letter_writer" | "cover_letter_reviewer", dependsOn: string[]) {
  return { key, taskId, templateId, goal: "Complete the selected job draft step", successCriteria: ["Persist an exact task result"],
    dependsOn, depth: templateId === "cover_letter_writer" ? 3 : 4, verificationDisposition: "specialized" }
}
