import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildObjectiveApplicationReviewMemberProof,
  buildObjectiveApplicationResumeWitness,
  OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA,
  objectiveApplicationApprovedIntentId,
  objectiveReviewedFillHandoffIdempotencyKey,
} from "@jobcopilot/shared"
import { readObjectiveJourneyReportApplication } from "./objective-journey-report-application"

const mocks = vi.hoisted(() => ({ outcome: vi.fn() }))
vi.mock("../control-plane/commands/objective-reviewed-application-fill-outcome", () => ({
  readObjectiveReviewedApplicationFillOutcome: mocks.outcome,
}))

const userId = "user-objective", sessionId = "session-objective", sourceTurnId = "source-turn-objective"
const reviewTurnId = "review-turn-objective", jobId = "job-objective", applicationTaskId = "application-task-objective"
const fillTurnId = "fill-turn-objective", slotOrdinal = 2, setId = `objective-review-${"a".repeat(40)}`
const approvalId = `objective-review:${setId}:${slotOrdinal}`, materialProofHash = "a".repeat(64)
const submitApprovalId = `application-fill:${applicationTaskId}:${fillTurnId}`
const approvedBody = "Objective application review approval recorded."
const fillText = "Fill the server-bound application form for user review. Never submit it."
const submitTitle = "Final submission authorization"
const submitBody = "The form was filled without submission. Review the current job, material alignment, required answers, and sensitive declarations before authorizing an external submission."
type Row = Record<string, unknown>

const resumeWitness = buildObjectiveApplicationResumeWitness({
  userId, jobId, resumeId: "resume-objective", finalResumeAssignmentRevision: 4, materialRevision: 7,
  material: { name: "Adapted", content: { skills: ["TypeScript"] }, templateId: "resume-template", templateOptions: null,
    kind: "adapted", targetJobId: jobId, parentResumeId: "resume-base", basicsDetached: false },
})
if (!resumeWitness) throw new Error("test resume witness was invalid")
const parsedProof = buildObjectiveApplicationReviewMemberProof({
  source: { jobId, sourceTurnId, rootTaskId: "root-objective", graphItemId: "graph-objective", graphRevision: 8,
    finalItemId: "source-final-item", slotOrdinal, writerTaskId: "writer-objective", reviewerTaskId: "reviewer-objective",
    reviewerToolCallId: "review-call-objective", reviewHash: `sha256:${"b".repeat(64)}`, artifactId: "artifact-objective",
    version: 3, contentHash: `sha256:${"c".repeat(64)}`, sourceDigest: `sha256:${"d".repeat(64)}` },
  resumeWitness,
})
if (!parsedProof) throw new Error("test member proof was invalid")
const proof: NonNullable<typeof parsedProof> = parsedProof
const binding = { userId, sessionId, sourceTurnId, sourceFinalItemId: "source-final-item", rootTaskId: "root-objective",
  graphItemId: "graph-objective", graphRevision: 8, writerTaskId: "writer-objective", reviewerTaskId: "reviewer-objective",
  slotOrdinal, jobId, reviewTurnId, setId, approvalId, applicationTaskId, materialProofHash: proof.materialProofHash }

function fixture(mode: "submit_wait" | "uncertain" = "submit_wait") {
  const expiresAt = new Date(Date.now() + 60_000), decidedAt = new Date(Date.now() - 30_000)
  const fillInput = { clientMessageId: objectiveReviewedFillHandoffIdempotencyKey(approvalId), content: [{ type: "text", text: fillText }],
    goal: fillText, reviewedApplicationMaterialSource: { schemaVersion: OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA,
      approvalId, reviewTurnId, materialProofHash: proof.materialProofHash } }
  const approvedIntent = { schemaVersion: "objective-application-review-approved-intent.v1", userId, sessionId, reviewTurnId,
    applicationTaskId, jobId, approvalId, setId, slotOrdinal, sourceTurnId, materialProofHash: proof.materialProofHash }
  const reviewApproval: Row = { id: approvalId, userId, sessionId, turnId: reviewTurnId, taskId: applicationTaskId,
    jobId, type: "review_application", status: "approved", consumedAt: null,
    payload: { schema: "objective-application-approval-set-member.v1", setId, sourceTurnId, slotOrdinal, proof } }
  const approvedEvent: Row = { id: objectiveApplicationApprovedIntentId(setId, slotOrdinal), taskId: applicationTaskId,
    type: "objective_application_review_approved", actor: "user", body: approvedBody, data: approvedIntent }
  const submitReceipt: Row = { id: submitApprovalId, userId, sessionId, turnId: fillTurnId, taskId: applicationTaskId,
    jobId, toolCallId: `application-submit:${applicationTaskId}`, type: "submit_application",
    status: mode === "uncertain" ? "consumed" : "pending", revision: 4, expiresAt,
    decidedAt: mode === "uncertain" ? decidedAt : null, consumedAt: mode === "uncertain" ? decidedAt : null,
    scopeHash: "e".repeat(64) }
  const waitContent: Row = { action: "submit_application", approvalId: submitApprovalId, body: submitBody, decision: null,
    expiresAt: expiresAt.toISOString(), impact: { externalSubmission: true, jobId }, receiptRevision: 4,
    scopeHash: submitReceipt.scopeHash, title: submitTitle, toolCallId: submitReceipt.toolCallId, waitKind: "approval" }
  const waitItem: Row = { id: `agent-wait:approval:${submitApprovalId}`, sessionId, turnId: fillTurnId,
    stepId: null, taskId: null, type: "approval_request", status: "started", phase: "commentary", revision: 0, content: waitContent }
  const task: Row = { id: applicationTaskId, userId, sessionId, jobId,
    status: mode === "uncertain" ? "waiting_for_user" : "waiting_for_authorization",
    checkpoint: mode === "uncertain" ? "submission_uncertain" : "form_filled", workerTaskId: "worker-objective",
    fillTurnId, fillTurnSessionId: sessionId, fillTurnUserId: userId, completedAt: null, error: null }
  const turn: Row = { id: fillTurnId, userId, sessionId, source: "user", executionMode: "canonical_task_graph",
    status: mode === "uncertain" ? "waiting_for_dependency" : "waiting_for_approval", input: fillInput,
    finalResponse: null, error: null, completedAt: null, rootTaskId: "fill-root-objective", leaseOwnerId: null,
    leaseExpiresAt: null, revision: 5 }
  const startEvent: Row = { id: "evt_execution-objective", taskId: applicationTaskId, type: "submission_execution_started",
    actor: "worker", body: "Submit execution started", data: { applicationTaskId, approvalId: submitApprovalId,
      constraintHash: submitReceipt.scopeHash, executionId: "execution-objective", fillTurnId, jobId, sessionId,
      userId, workerTaskId: task.workerTaskId } }
  const tx = {
    agentApproval: { findMany: vi.fn(async ({ where }: { where: Row }) =>
      [reviewApproval, submitReceipt].filter(row => row.id === where.id && row.type === where.type && row.status === where.status).slice(0, 2)) },
    applicationTask: { findMany: vi.fn(async () => [task]) },
    agentTurn: { findMany: vi.fn(async () => [turn]) },
    applicationTaskEvent: { findMany: vi.fn(async ({ where }: { where: Row }) =>
      [approvedEvent, startEvent].filter(row => row.taskId === where.taskId && row.type === where.type).slice(0, 2)) },
    agentItem: { findMany: vi.fn(async ({ where }: { where: Row }) =>
      [waitItem].filter(row => row.id === where.id && row.type === where.type && row.status === where.status).slice(0, 2)) },
  }
  return { tx, submitReceipt, waitItem, task, turn, startEvent }
}

describe("readObjectiveJourneyReportApplication", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("recognizes an exact live pending final-submit approval and its matching wait", async () => {
    const value = fixture()
    expect(await readObjectiveJourneyReportApplication(value.tx as never, binding)).toEqual({
      applicationStatus: "awaiting_submit_approval", submissionEvidence: null,
    })
  })

  it.each([
    ["wrong tool call", (value: ReturnType<typeof fixture>) => { value.submitReceipt.toolCallId = "application-submit:other" }],
    ["expired receipt", (value: ReturnType<typeof fixture>) => { value.submitReceipt.expiresAt = new Date(Date.now() - 1) }],
    ["already decided", (value: ReturnType<typeof fixture>) => { value.submitReceipt.decidedAt = new Date() }],
    ["already consumed", (value: ReturnType<typeof fixture>) => { value.submitReceipt.consumedAt = new Date() }],
    ["revision mismatch", (value: ReturnType<typeof fixture>) => { value.turn.revision = 6 }],
    ["wrong wait scope", (value: ReturnType<typeof fixture>) => { (value.waitItem.content as Row).scopeHash = "f".repeat(64) }],
    ["expanded wait content", (value: ReturnType<typeof fixture>) => { (value.waitItem.content as Row).privateNote = "unexpected" }],
  ])("fails closed for %s", async (_name, mutate) => {
    const value = fixture()
    mutate(value)
    expect(await readObjectiveJourneyReportApplication(value.tx as never, binding)).toEqual({
      applicationStatus: "unknown", submissionEvidence: null,
    })
  })

  it("recognizes uncertainty only with the exact consumed receipt and start event", async () => {
    const value = fixture("uncertain")
    expect(await readObjectiveJourneyReportApplication(value.tx as never, binding)).toEqual({
      applicationStatus: "uncertain", submissionEvidence: null,
    })
    value.startEvent.data = { ...(value.startEvent.data as Row), constraintHash: "f".repeat(64) }
    expect(await readObjectiveJourneyReportApplication(value.tx as never, binding)).toEqual({
      applicationStatus: "unknown", submissionEvidence: null,
    })
  })
})
