import { createHash } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { describe, expect, it, vi } from "vitest"
import {
  buildObjectiveApplicationReviewMemberProof,
  buildObjectiveApplicationResumeWitness,
  buildObjectiveApplicationSubmissionManifest,
  hashAgentReceiptValue,
  hashContent,
  hashObjectiveApplicationSubmissionMaterial,
  hashReviewedApplicationMaterialProof,
  OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_SCHEMA,
  OBJECTIVE_APPLICATION_SUBMISSION_MATERIAL_SCHEMA,
  OBJECTIVE_REVIEWED_FILL_BROWSER_START_SCHEMA,
  OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA,
  parseObjectiveApplicationApprovedIntent,
  parseObjectiveApplicationReviewMemberProof,
  parseObjectiveApplicationSubmissionManifestEvent,
  parseObjectiveReviewedApplicationFillBrowserStartEvent,
  parseObjectiveReviewedFillSource,
} from "@jobcopilot/shared"
import { OBJECTIVE_APPLICATION_APPROVAL_SET_SCHEMA, objectiveApplicationApprovalSetItemId, parseObjectiveApplicationApprovalSet } from "@jobcopilot/agent-protocol"
import {
  parseObjectiveApplicationSubmitResultReceipt,
  OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_BODY,
  OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_TYPE,
  OBJECTIVE_APPLICATION_SUBMIT_RESULT_SCHEMA,
  objectiveApplicationSubmitResultEventId,
} from "../../../../../../worker/src/db/objective-application-submit-result.js"
import {
  parseObjectiveApplicationSubmitFinalizationReceipt,
  OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_EVENT_BODY,
  OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_EVENT_TYPE,
  OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_SCHEMA,
  objectiveApplicationSubmitFinalizationEventId,
} from "../../../../../../worker/src/runtime/turns/recovery-scanner-objective-submit.js"
import { readObjectiveWaveSubmissionEvidence, type ObjectiveWaveEvidenceSlot } from "./application-task-full-loop.objective-wave-evidence"

const scope = { userId: "user-a", sessionId: "session-a", reviewTurnId: "review-turn-a" }
const fillTurnId = "fill-turn-a", applicationTaskId = "application-task-a", jobId = "job-a"
const slot: ObjectiveWaveEvidenceSlot = { ordinal: 2, routeOrdinal: 2, reviewApprovalId: `objective-review:${setId()}:2`,
  applicationTaskId, jobId, corrected: true, expectedCoverLetterSha256: createHash("sha256").update("letter bytes").digest("hex") }

describe("Objective wave submission evidence", () => {
  it("accepts a closed durable result when proof and synthetic site hashes are distinct", async () => {
    const fixture = await completeFixture()
    expect(parseObjectiveApplicationApprovalSet(fixture.setContent)).not.toBeNull()
    expect(parseObjectiveApplicationReviewMemberProof(fixture.member.proof)).not.toBeNull()
    expect(parseObjectiveReviewedFillSource(fixture.fillSource)).not.toBeNull()
    expect(parseObjectiveApplicationApprovedIntent(fixture.approvedIntent)).not.toBeNull()
    expect(parseObjectiveApplicationSubmissionManifestEvent(fixture.manifestPacket)).not.toBeNull()
    expect(parseObjectiveReviewedApplicationFillBrowserStartEvent(fixture.browser)).not.toBeNull()
    expect(parseObjectiveApplicationSubmitResultReceipt(fixture.result)).not.toBeNull()
    expect(parseObjectiveApplicationSubmitFinalizationReceipt(fixture.finalization)).not.toBeNull()
    expect(fixture.manifest.material.reviewedCoverLetterHash).not.toBe(slot.expectedCoverLetterSha256)
    const evidence = await readObjectiveWaveSubmissionEvidence(fixture.client, { scope, slot, fillTurnId })
    expect(evidence).toMatchObject({
      scope, slot, fillTurnId, task: { id: applicationTaskId, status: "submitted" },
      result: { count: 1, status: "submitted", jobId }, finalization: { count: 1, itemStatus: "completed" },
    })
    expect(fixture.client.submissionAttempt.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ constraintHash: fixture.approval.scopeHash }),
    }))
  })

  it("rejects a manifest whose valid proof hash does not match the browser-start proof", async () => {
    const fixture = await completeFixture({ wrongManifestProofHash: true })
    await expect(readObjectiveWaveSubmissionEvidence(fixture.client, { scope, slot, fillTurnId })).resolves.toBeNull()
  })

  it("rejects a consumed approval that commits to a different V3 manifest", async () => {
    const fixture = await completeFixture({ wrongApprovalMaterialHash: true })
    await expect(readObjectiveWaveSubmissionEvidence(fixture.client, { scope, slot, fillTurnId })).resolves.toBeNull()
  })

  it("rejects invalid caller identities before any database read", async () => {
    const fixture = await completeFixture()
    await expect(readObjectiveWaveSubmissionEvidence(fixture.client, { scope, slot: { ...slot,
      expectedCoverLetterSha256: "not-a-digest" }, fillTurnId })).resolves.toBeNull()
    expect(fixture.client.agentTurn.findMany).not.toHaveBeenCalled()
  })
})

async function completeFixture(options: { wrongManifestProofHash?: boolean; wrongApprovalMaterialHash?: boolean } = {}) {
  const set = setId(), approvalId = `objective-review:${set}:2`, constraintHash = "c".repeat(64)
  const browserProof = { jobId, sourceTurnId: "source-turn-a", rootTaskId: "source-root-a", graphRevision: 9,
    writerTaskId: "writer-a", reviewerTaskId: "reviewer-a",
    reviewerToolCallId: "review-call-a", reviewHash: `sha256:${"a".repeat(64)}`, artifactId: "artifact-a", version: 1,
    contentHash: `sha256:${"b".repeat(64)}`, sourceDigest: `sha256:${"d".repeat(64)}` }
  const memberSource = { ...browserProof, graphItemId: "source-graph-a", finalItemId: "source-final-a", slotOrdinal: 2 }
  const resumeWitness = buildObjectiveApplicationResumeWitness({ userId: scope.userId, jobId, resumeId: "resume-a",
    finalResumeAssignmentRevision: 2, materialRevision: 3, material: { name: "Adapted", content: { summary: "Engineer" },
      templateId: null, templateOptions: null, kind: "adapted", targetJobId: jobId, parentResumeId: "base-a", basicsDetached: false } })!
  const memberProof = buildObjectiveApplicationReviewMemberProof({ source: memberSource, resumeWitness })!
  const source = { schemaVersion: OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA, approvalId, reviewTurnId: scope.reviewTurnId,
    materialProofHash: memberProof!.materialProofHash }
  const fillSource = { reviewedApplicationMaterialSource: source }
  const approvedIntent = { schemaVersion: "objective-application-review-approved-intent.v1", userId: scope.userId,
    sessionId: scope.sessionId, reviewTurnId: scope.reviewTurnId, applicationTaskId, jobId, approvalId, setId: set,
    slotOrdinal: 2, sourceTurnId: "source-turn-a", materialProofHash: source.materialProofHash }
  const proofHash = await hashReviewedApplicationMaterialProof(browserProof)
  const material = { schemaVersion: OBJECTIVE_APPLICATION_SUBMISSION_MATERIAL_SCHEMA,
    applicationTaskId, jobId, resumeId: "resume-a", coverLetterId: "cover-letter-a",
    reviewedCoverLetterHash: options.wrongManifestProofHash ? "f".repeat(64) : proofHash!, objectiveSource: source }
  const confirmedAnswers = { questionA: "yes" }
  const answersHash = (await hashAgentReceiptValue("answers", confirmedAnswers))!
  const manifest = buildObjectiveApplicationSubmissionManifest(material, answersHash)!
  const manifestHash = hashContent(manifest)
  const materialHash = (await hashObjectiveApplicationSubmissionMaterial(manifest.material))!
  const manifestPacket = { schemaVersion: OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_SCHEMA,
    scope: { userId: scope.userId, sessionId: scope.sessionId, applicationTaskId, jobId, fillTurnId }, manifest, hash: manifestHash }
  const browser = { schemaVersion: OBJECTIVE_REVIEWED_FILL_BROWSER_START_SCHEMA, userId: scope.userId, sessionId: scope.sessionId,
    fillTurnId, applicationTaskId, fillerTaskId: "filler-a", attemptCount: 1, leaseOwner: "worker-a",
    leaseExpiresAt: "2026-11-24T12:00:00.000Z", ...browserProof, objectiveSource: source }
  const approval = { id: `application-fill:${applicationTaskId}:${fillTurnId}`, userId: scope.userId, sessionId: scope.sessionId,
    turnId: fillTurnId, taskId: applicationTaskId, jobId, type: "submit_application", status: "consumed",
    consumedAt: new Date("2026-11-24T11:01:00Z"), toolCallId: `application-submit:${applicationTaskId}`,
    scopeHash: constraintHash, resourceHash: manifestHash.slice(7), materialHash: options.wrongApprovalMaterialHash ? "7".repeat(64) : materialHash,
    answersHash }
  const execution = { userId: scope.userId, sessionId: scope.sessionId, applicationTaskId, jobId, fillTurnId,
    approvalId: approval.id, constraintHash, workerTaskId: "worker-task-a", executionId: "execution-a" }
  const result = { schemaVersion: OBJECTIVE_APPLICATION_SUBMIT_RESULT_SCHEMA, ...execution, attemptId: "attempt-a", applyResultId: 91 }
  const resultEventId = objectiveApplicationSubmitResultEventId(execution)
  const finalization = { schemaVersion: OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_SCHEMA, ...execution,
    attemptId: result.attemptId, resultLinkEventId: resultEventId, applyResultId: result.applyResultId }
  const finalizationId = objectiveApplicationSubmitFinalizationEventId(execution, resultEventId)
  const executionRow = { ...execution }
  const at = new Date("2026-11-24T11:02:00Z")
  const events = [
    event("approved", applicationTaskId, "objective_application_review_approved", "user", "Objective application review approval recorded.", approvedIntent, at),
    event("browser", applicationTaskId, "reviewed_application_fill_browser_started", "worker", "Reviewed application material bound to browser-start attempt.", browser, at),
    event("manifest", applicationTaskId, "objective_submission_manifest_recorded", "worker", "Objective submission manifest recorded for this fill attempt.", manifestPacket, at),
    event(resultEventId, applicationTaskId, OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_TYPE, "worker", OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_BODY, result, at),
    event(`evt_${execution.executionId}`, applicationTaskId, "submission_execution_started", "worker", "Submit execution started", executionRow, at),
    event("settled-a", applicationTaskId, "submission_execution_settled", "worker", "Submit execution settled", executionRow, at),
    event(finalizationId, applicationTaskId, OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_EVENT_TYPE, "worker",
      OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_EVENT_BODY, finalization, at),
  ]
  const finalItemId = `turn:${fillTurnId}:item:final:objective-application-submit-finalize:${fillTurnId}`
  const final = { schemaVersion: "agent-harness.v2.final", completed: true, terminalReason: "goal_satisfied",
    evidenceRefs: ["objective_application_submit_site_confirmation"] }
  const delegates = {
    agentTurn: { findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => [where.id === scope.reviewTurnId
      ? { id: scope.reviewTurnId, userId: scope.userId, sessionId: scope.sessionId, status: "completed", source: "user",
        executionMode: "canonical_task_graph" }
      : { id: fillTurnId, userId: scope.userId, sessionId: scope.sessionId, status: "completed", executionMode: "canonical_task_graph",
        rootTaskId: "fill-root-a", finalResponse: final, input: fillSource }]) },
    applicationTask: { findMany: vi.fn(async () => [{ id: applicationTaskId, userId: scope.userId, sessionId: scope.sessionId, jobId,
      fillTurnId, fillTurnUserId: scope.userId, fillTurnSessionId: scope.sessionId, status: "submitted", checkpoint: "submission_verified",
      completedAt: at, workerTaskId: execution.workerTaskId, resumeId: "resume-a", coverLetterId: "cover-letter-a", confirmedAnswers }]) },
    job: { findMany: vi.fn(async () => [{ id: jobId, userId: scope.userId, status: "applied", workflowState: "submitted", appliedAt: at }]) },
    agentItem: { findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => [where.id === objectiveApplicationApprovalSetItemId(set)
      ? { id: objectiveApplicationApprovalSetItemId(set), type: "approval_request", status: "completed", revision: 1,
        content: { schema: OBJECTIVE_APPLICATION_APPROVAL_SET_SCHEMA, waitKind: "approval_set", setId: set,
          sourceTurnId: "source-turn-a", intentHash: "1".repeat(64), expiresAt: "2026-11-24T12:00:00.000Z",
          members: [{ slotOrdinal: 2, approvalId }] } }
      : { id: finalItemId, type: "agent_message", status: "completed", phase: "final_answer", revision: 1, completedAt: at,
        content: { text: "The application site confirmed that the application was submitted.", final } }]) },
    agentApproval: { findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => [where.type === "review_application"
      ? { id: approvalId, userId: scope.userId, sessionId: scope.sessionId, turnId: scope.reviewTurnId,
        taskId: applicationTaskId, jobId, type: "review_application", status: "approved", consumedAt: null,
        toolCallId: `objective_review_application:${set}:2`, payload: { schema: "objective-application-approval-set-member.v1",
          setId: set, sourceTurnId: "source-turn-a", slotOrdinal: 2, proof: memberProof } }
      : approval]) },
    applicationTaskEvent: { findMany: vi.fn(async () => events) },
    applyResult: { findMany: vi.fn(async () => [{ id: result.applyResultId, userId: scope.userId, jobId, mode: "unattended",
      atsType: "greenhouse", flowUsed: "application.submit", status: "submitted", error: null }]) },
    submissionAttempt: { findMany: vi.fn(async () => [{ id: result.attemptId, userId: scope.userId, jobId,
      receiptId: approval.id, state: "submitted", constraintHash, artifactHash: approval.resourceHash, responseRef: "response-a" }]) },
    subAgentTask: { findMany: vi.fn(async () => [{ id: "fill-root-a", sessionId: scope.sessionId, turnId: fillTurnId,
      rootTaskId: "fill-root-a", parentTaskId: null, role: "orchestrator", taskType: "root", status: "completed",
      failureReason: null, leaseOwner: null, leaseExpiresAt: null, completedAt: at,
      result: { status: "completed", finalItemId, waitId: null } }]) },
    agentEvent: { findMany: vi.fn(async () => [{ id: `turn:${fillTurnId}:event:turn-completed`, sessionId: scope.sessionId,
      turnId: fillTurnId, type: "turn.completed", itemId: finalItemId,
      correlationId: `objective-application-submit-finalize:${fillTurnId}` }]) },
  }
  const setContent = { schema: OBJECTIVE_APPLICATION_APPROVAL_SET_SCHEMA, waitKind: "approval_set", setId: set,
    sourceTurnId: "source-turn-a", intentHash: "1".repeat(64), expiresAt: "2026-11-24T12:00:00.000Z",
    members: [{ slotOrdinal: 2, approvalId }] }
  const member = { schema: "objective-application-approval-set-member.v1", setId: set, sourceTurnId: "source-turn-a",
    slotOrdinal: 2, proof: memberProof }
  return { client: delegates as unknown as PrismaClient, manifest, approval, setContent, member, fillSource,
    approvedIntent, manifestPacket, browser, result, finalization }
}

function event(id: string, taskId: string, type: string, actor: string, body: string, data: unknown, createdAt: Date) {
  return { id, taskId, type, actor, body, data, createdAt }
}
function setId() { return `objective-review-${createHash("sha256").update(`objective-application-review-set.v1\0${scope.sessionId}\0${scope.reviewTurnId}`).digest("hex").slice(0, 40)}` }
