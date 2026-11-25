import { describe, expect, it, vi } from "vitest"
import { buildObjectiveApplicationResumeWitness, buildObjectiveApplicationReviewMemberProof } from "@jobcopilot/shared"
import {
  OBJECTIVE_APPLICATION_APPROVAL_RETIREMENT_REASONS, parseObjectiveApplicationApprovalRetirement,
  readObjectiveApplicationApprovalRetirement,
} from "./objective-application-approval-retirement"

const scope = {
  userId: "user-1", sessionId: "session-1", reviewTurnId: "review-turn-1", sourceTurnId: "source-turn-1",
  setId: "review-set-1", slotOrdinal: 2, jobId: "job-2", applicationTaskId: "application-task-2",
  approvalId: "approval-2", receiptRevision: 4,
} as const
const reason = "resume_material_changed"
const body = "Objective application review member was retired."
const eventType = "objective_application_review_retired"

function event(overrides: Record<string, unknown> = {}) {
  return { id: `objective-application-review-retired:${scope.setId}:${scope.slotOrdinal}`,
    taskId: scope.applicationTaskId, type: eventType, actor: "system", body,
    data: { schemaVersion: "objective-application-review-retirement.v1", ...scope, reason }, ...overrides }
}
function approval(overrides: Record<string, unknown> = {}) {
  const resumeWitness = buildObjectiveApplicationResumeWitness({ userId: scope.userId, jobId: scope.jobId,
    resumeId: "resume-2", finalResumeAssignmentRevision: 3, materialRevision: 4,
    material: { name: "Tailored", content: { experience: ["verified"] }, templateId: "resume", templateOptions: null,
      kind: "adapted", targetJobId: scope.jobId, parentResumeId: "resume-base", basicsDetached: false } })!
  const proof = buildObjectiveApplicationReviewMemberProof({ resumeWitness, source: {
    jobId: scope.jobId, sourceTurnId: scope.sourceTurnId, rootTaskId: "source-root", graphItemId: "source-graph",
    graphRevision: 9, finalItemId: "source-final", slotOrdinal: scope.slotOrdinal, writerTaskId: "writer-2",
    reviewerTaskId: "reviewer-2", reviewerToolCallId: "review-call-2", reviewHash: `sha256:${"a".repeat(64)}`,
    artifactId: "artifact-2", version: 5, contentHash: `sha256:${"b".repeat(64)}`, sourceDigest: `sha256:${"c".repeat(64)}`,
  } })!
  return { id: scope.approvalId, userId: scope.userId, sessionId: scope.sessionId, turnId: scope.reviewTurnId,
    taskId: scope.applicationTaskId, jobId: scope.jobId, type: "review_application", status: "expired", revision: scope.receiptRevision,
    payload: { schema: "objective-application-approval-set-member.v1", setId: scope.setId,
      sourceTurnId: scope.sourceTurnId, slotOrdinal: scope.slotOrdinal, proof }, ...overrides }
}

function client(options: { tasks?: readonly unknown[]; approvals?: readonly unknown[]; events?: readonly unknown[] } = {}) {
  return {
    applicationTask: { findMany: vi.fn(async () => options.tasks ?? [{ id: scope.applicationTaskId,
      userId: scope.userId, sessionId: scope.sessionId, jobId: scope.jobId }]) },
    agentApproval: { findMany: vi.fn(async () => options.approvals ?? [approval()]) },
    applicationTaskEvent: { findMany: vi.fn(async () => options.events ?? [event()]) },
  }
}

describe("Objective application approval retirement evidence", () => {
  it("accepts only the exact closed private event and full expected member scope", () => {
    expect(OBJECTIVE_APPLICATION_APPROVAL_RETIREMENT_REASONS).toEqual([
      "approval_ttl_reached", "approval_revision_changed", "resume_witness_unavailable",
      "resume_material_changed", "completed_source_changed",
    ])
    expect(parseObjectiveApplicationApprovalRetirement(event(), scope)).toBe(reason)
    expect(parseObjectiveApplicationApprovalRetirement(event({ id: "other" }), scope)).toBeUndefined()
    expect(parseObjectiveApplicationApprovalRetirement(event({ data: { ...event().data, reason: "guess" } }), scope)).toBeUndefined()
    expect(parseObjectiveApplicationApprovalRetirement(event({ data: { ...event().data, privateHash: "f".repeat(64) } }), scope)).toBeUndefined()
    expect(parseObjectiveApplicationApprovalRetirement(event({ data: { ...event().data, jobId: "foreign-job" } }), scope)).toBeUndefined()
    const accessor = Object.defineProperty(event(), "taskId", { enumerable: true, get: () => scope.applicationTaskId })
    expect(parseObjectiveApplicationApprovalRetirement(accessor, scope)).toBeUndefined()
  })

  it("requires one linked expired receipt, owner task, and matching private event", async () => {
    const tx = client()
    await expect(readObjectiveApplicationApprovalRetirement(tx as never, scope)).resolves.toBe(reason)
    expect(tx.applicationTask.findMany).toHaveBeenCalledOnce()
    expect(tx.agentApproval.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: scope.approvalId, userId: scope.userId, sessionId: scope.sessionId,
        turnId: scope.reviewTurnId, taskId: scope.applicationTaskId, jobId: scope.jobId, type: "review_application",
        status: "expired", revision: scope.receiptRevision }), take: 2,
    }))
  })

  it.each([
    ["historical receipt without retirement record", { events: [] }],
    ["ambiguous private records", { events: [event(), event({ id: "duplicate" })] }],
    ["foreign task", { tasks: [{ id: "foreign-task" }] }],
    ["wrong approval state", { approvals: [approval({ status: "pending" })] }],
    ["malformed private reason", { events: [event({ data: { ...event().data, reason: "other" } })] }],
  ] as const)("returns unavailable for %s", async (_label, options) => {
    await expect(readObjectiveApplicationApprovalRetirement(client(options) as never, scope)).resolves.toBeUndefined()
  })
})
