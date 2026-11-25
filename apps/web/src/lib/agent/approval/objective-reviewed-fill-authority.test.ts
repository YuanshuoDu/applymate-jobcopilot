import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { objectiveApplicationApprovalSetItemId } from "@jobcopilot/agent-protocol"
import {
  buildObjectiveApplicationReviewMemberProof,
  buildObjectiveApplicationResumeWitness,
  objectiveApplicationApprovedIntentId,
} from "@jobcopilot/shared"

const mocks = vi.hoisted(() => ({
  loadMembers: vi.fn(),
  verifySource: vi.fn(),
  readResume: vi.fn(),
}))

vi.mock("../broker/objective-approval-set-decision-data", async importOriginal => {
  const actual = await importOriginal<typeof import("../broker/objective-approval-set-decision-data")>()
  return { ...actual, loadLockedObjectiveApprovalSetMembers: mocks.loadMembers }
})
vi.mock("../broker/objective-application-review-source", () => ({ verifyObjectiveApplicationReviewSource: mocks.verifySource }))
vi.mock("./objective-application-resume-witness", () => ({ readObjectiveApplicationResumeWitness: mocks.readResume }))

import { readObjectiveReviewedFillAuthority, verifyObjectiveReviewedFillFreshness } from "./objective-reviewed-fill-authority"
import { ReviewedFillHandoffDeferredError } from "./reviewed-fill-handoff"
import { ReviewedFillSourceBindingError } from "./reviewed-fill-source-binding"

const userId = "owner-1", sessionId = "session-1", predecessorTurnId = "review-turn-1"
const sourceTurnId = "source-turn-1", applicationTaskId = "application-task-1", jobId = "job-1"
const setId = `objective-review-${"a".repeat(40)}`, slotOrdinal = 1
const approvalId = `objective-review:${setId}:${slotOrdinal}`
const intent = { schemaVersion: "agent-harness.v2.objective-reviewed-fill-handoff.v1" as const,
  userId, sessionId, applicationTaskId, approvalId, predecessorTurnId }
const materialProofHash = "b".repeat(64)
const now = new Date("2026-11-24T12:00:00.000Z")
const expiresAt = new Date("2026-11-24T13:00:00.000Z")

function fixture(options: { turnStatus?: string; badWake?: boolean } = {}) {
  const resumeWitness = buildObjectiveApplicationResumeWitness({ userId, jobId, resumeId: "resume-1",
    finalResumeAssignmentRevision: 2, materialRevision: 3,
    material: { name: "Adapted", content: { skills: ["TypeScript"] }, templateId: null, templateOptions: null,
      kind: "adapted", targetJobId: jobId, parentResumeId: null, basicsDetached: false } })!
  const proof = buildObjectiveApplicationReviewMemberProof({ source: { jobId, sourceTurnId,
    rootTaskId: "root-1", graphItemId: "graph-1", graphRevision: 9, finalItemId: "final-1", slotOrdinal,
    writerTaskId: "writer-task-1", reviewerTaskId: "reviewer-task-1", reviewerToolCallId: "review-call-1",
    reviewHash: `sha256:${"c".repeat(64)}`, artifactId: "artifact-1", version: 1,
    contentHash: `sha256:${"d".repeat(64)}`, sourceDigest: `sha256:${"e".repeat(64)}` }, resumeWitness })!
  const intentHash = createHash("sha256").update("intent").digest("hex")
  const set = { schema: "objective-application-approval-set.v1", waitKind: "approval_set", setId,
    sourceTurnId, intentHash, expiresAt: expiresAt.toISOString(), members: [{ slotOrdinal, approvalId }] }
  const envelope = { schema: "objective-application-approval-set-member.v1", setId, sourceTurnId, slotOrdinal, proof }
  const approval = { id: approvalId, userId, sessionId, turnId: predecessorTurnId, taskId: applicationTaskId,
    type: "review_application", status: "approved", expiresAt, decidedAt: now, payload: envelope }
  const member = { approvalId, taskId: applicationTaskId, userId, sessionId, turnId: predecessorTurnId,
    jobId, toolCallId: "tool-call-1", scopeHash: "f".repeat(64), revision: 1, expiresAt, proof, resumeWitness }
  const selected = { slotOrdinal, row: approval, member }
  const approvedIntent = { schemaVersion: "objective-application-review-approved-intent.v1", userId, sessionId,
    reviewTurnId: predecessorTurnId, applicationTaskId, jobId, approvalId, setId, slotOrdinal,
    sourceTurnId, materialProofHash: proof.materialProofHash }
  const itemId = objectiveApplicationApprovalSetItemId(setId)
  const completedEvent = { id: "completed-event-1", itemId, actor: "orchestrator", taskId: null,
    causationId: itemId, payload: { itemId, status: "completed" } }
  const wakeEvent = { id: "wakeup-event-1", itemId, actor: "user", taskId: null,
    causationId: options.badWake ? "wrong-cause" : completedEvent.id,
    payload: { waitKind: "approval_set", waitId: setId, itemId, turnId: predecessorTurnId,
      toolCallId: null, status: "resolved", nextTurnRevision: 2 } }
  const tx = {
    agentApproval: { findFirst: vi.fn(async () => approval) },
    $queryRaw: vi.fn(async () => [{ id: itemId }]),
    agentItem: { findFirst: vi.fn(async () => ({ id: itemId, status: "completed", revision: 1,
      phase: "commentary", stepId: null, taskId: null, content: set })) },
    agentTurn: { findFirst: vi.fn(async () => ({ id: predecessorTurnId, status: options.turnStatus ?? "completed" })) },
    applicationTaskEvent: { findUnique: vi.fn(async () => ({ id: objectiveApplicationApprovedIntentId(setId, slotOrdinal),
      taskId: applicationTaskId, type: "objective_application_review_approved", actor: "user",
      body: "Objective application review approval recorded.", data: approvedIntent })) },
    agentEvent: { findMany: vi.fn(async ({ where }: { where: { type: string } }) =>
      where.type === "item.completed" ? [completedEvent] : [wakeEvent]) },
  }
  mocks.loadMembers.mockResolvedValue([selected])
  mocks.readResume.mockResolvedValue(resumeWitness)
  mocks.verifySource.mockResolvedValue("current")
  return { tx, itemId, set, proof, resumeWitness, selected, wakeEvent }
}

beforeEach(() => vi.clearAllMocks())

describe("Objective reviewed fill authority", () => {
  it("requires the completed approval set, exact pointer and causal wake before freshness", async () => {
    const { tx, itemId } = fixture()
    const authority = await readObjectiveReviewedFillAuthority(tx as never, intent, now)
    expect(authority).toMatchObject({ jobId, resumeId: "resume-1", source: { approvalId, reviewTurnId: predecessorTurnId } })
    await verifyObjectiveReviewedFillFreshness(tx as never, authority)
    expect(mocks.verifySource).toHaveBeenCalledWith(tx, authority.input, "completed_review")
    expect(mocks.readResume).toHaveBeenCalledWith(tx, { userId, jobId })
    expect(tx.agentItem.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
      id: itemId, sessionId, turnId: predecessorTurnId, type: "approval_request" },
    }))
  })

  it("rejects a wake that is not caused by the exact item completion", async () => {
    const { tx } = fixture({ badWake: true })
    await expect(readObjectiveReviewedFillAuthority(tx as never, intent, now))
      .rejects.toBeInstanceOf(ReviewedFillSourceBindingError)
  })

  it("defers until the exact predecessor review Turn is completed", async () => {
    const { tx } = fixture({ turnStatus: "waiting_for_user" })
    await expect(readObjectiveReviewedFillAuthority(tx as never, intent, now))
      .rejects.toBeInstanceOf(ReviewedFillHandoffDeferredError)
  })

  it("fails closed when the completed review or current Resume no longer matches", async () => {
    const { tx, selected, resumeWitness } = fixture()
    const authority = await readObjectiveReviewedFillAuthority(tx as never, intent, now)
    mocks.verifySource.mockResolvedValueOnce("stale")
    await expect(verifyObjectiveReviewedFillFreshness(tx as never, authority))
      .rejects.toBeInstanceOf(ReviewedFillSourceBindingError)
    mocks.verifySource.mockResolvedValue("current")
    mocks.readResume.mockResolvedValueOnce({ ...resumeWitness, materialRevision: resumeWitness.materialRevision + 1 })
    await expect(verifyObjectiveReviewedFillFreshness(tx as never, authority))
      .rejects.toBeInstanceOf(ReviewedFillSourceBindingError)
    expect(selected.member.resumeWitness).toEqual(resumeWitness)
  })
})
