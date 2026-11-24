import { describe, expect, it, vi } from "vitest"
import { hashApprovalScope, parseObjectiveApplicationApprovalSet } from "@jobcopilot/agent-protocol"
import { buildObjectiveApplicationResumeWitness, buildObjectiveApplicationReviewMemberProof } from "@jobcopilot/shared"
import { protocolScope } from "../approval/types"
import { loadLockedObjectiveApprovalSetMembers, parseObjectiveApprovalSetMemberEnvelope } from "./objective-approval-set-decision-data"

const userId = "00000000-0000-4000-8000-000000000001"
const sessionId = "00000000-0000-4000-8000-000000000002"
const turnId = "00000000-0000-4000-8000-000000000003"
const sourceTurnId = "00000000-0000-4000-8000-000000000004"
const expiresAt = new Date("2026-12-01T12:00:00.000Z")
const setContent = parseObjectiveApplicationApprovalSet({
  schema: "objective-application-approval-set.v1", waitKind: "approval_set", setId: "set-1", sourceTurnId,
  intentHash: "a".repeat(64), expiresAt: expiresAt.toISOString(),
  members: [{ slotOrdinal: 1, approvalId: "approval-1" }, { slotOrdinal: 2, approvalId: "approval-2" }],
})!

function witness(jobId: string) {
  return buildObjectiveApplicationResumeWitness({
    userId, jobId, resumeId: "resume-" + jobId, finalResumeAssignmentRevision: 2, materialRevision: 3,
    material: { name: "Tailored", content: { experience: ["verified"] }, templateId: "resume", templateOptions: null,
      kind: "adapted", targetJobId: jobId, parentResumeId: "resume-base", basicsDetached: false },
  })!
}

function memberProof(jobId: string, ordinal: number) {
  return buildObjectiveApplicationReviewMemberProof({ resumeWitness: witness(jobId), source: {
    jobId, sourceTurnId, rootTaskId: "source-root-1", graphItemId: "source-graph-1", graphRevision: 9,
    finalItemId: "source-final-1", slotOrdinal: ordinal, writerTaskId: `writer-${ordinal}`, reviewerTaskId: `reviewer-${ordinal}`,
    reviewerToolCallId: `review-call-${ordinal}`, reviewHash: `sha256:${"a".repeat(64)}`, artifactId: `artifact-${ordinal}`,
    version: 4, contentHash: `sha256:${"b".repeat(64)}`, sourceDigest: `sha256:${"c".repeat(64)}`,
  } })!
}

async function rows() {
  return Promise.all(setContent.members.map(async member => {
    const jobId = "job-" + member.slotOrdinal, toolCallId = "call-" + member.slotOrdinal
    const proof = memberProof(jobId, member.slotOrdinal)
    const nonceHash = "sha256:" + String(member.slotOrdinal).padStart(64, "0")
    const scope = { userId, sessionId, turnId, jobId, toolCallId, action: "review_application" as const,
      resourceHash: "sha256:" + "b".repeat(64), materialHash: proof.materialProofHash,
      answersHash: "sha256:" + "d".repeat(64), revision: 4, expiresAt }
    const scopeHash = await hashApprovalScope(protocolScope(scope, nonceHash))
    return { id: member.approvalId, userId, sessionId, turnId, taskId: null, jobId, toolCallId,
      type: "review_application", status: "pending", revision: 4, scopeHash, nonceHash,
      resourceHash: scope.resourceHash, materialHash: scope.materialHash, answersHash: scope.answersHash,
      expiresAt, createdAt: new Date(), updatedAt: new Date(), decidedAt: null, consumedAt: null,
      payload: { schema: "objective-application-approval-set-member.v1", setId: setContent.setId, sourceTurnId,
        slotOrdinal: member.slotOrdinal, proof },
    }
  }))
}

describe("Objective approval-set decision data", () => {
  it("parses only the closed member envelope", () => {
    const proof = memberProof("job-1", 1)
    const valid = { schema: "objective-application-approval-set-member.v1", setId: "set-1", sourceTurnId, slotOrdinal: 1, proof }
    expect(parseObjectiveApprovalSetMemberEnvelope(valid)).toEqual(valid)
    expect(parseObjectiveApprovalSetMemberEnvelope({ ...valid, scopeHash: "private" })).toBeNull()
    expect(parseObjectiveApprovalSetMemberEnvelope({ ...valid, slotOrdinal: 0 })).toBeNull()
    expect(parseObjectiveApprovalSetMemberEnvelope({ ...valid, proof: {} })).toBeNull()
    expect(parseObjectiveApprovalSetMemberEnvelope({ ...valid, proof: { ...proof, materialProofHash: "0".repeat(64) } })).toBeNull()
  })

  it("locks and validates every member scope and witness", async () => {
    const approvalRows = await rows()
    const query = vi.fn(async () => approvalRows.map(row => ({ id: row.id })))
    const tx = {
      $queryRaw: query,
      agentApproval: { findMany: vi.fn(async () => approvalRows) },
    }
    const result = await loadLockedObjectiveApprovalSetMembers(tx as never,
      { userId, sessionId, expectedTurnId: turnId, approvalId: "approval-1" }, setContent)

    expect(query).toHaveBeenCalledOnce()
    expect(result.map(entry => [entry.member.approvalId, entry.slotOrdinal])).toEqual([["approval-1", 1], ["approval-2", 2]])
    expect(result[0]?.member.resumeWitness.jobId).toBe("job-1")
  })

  it("rejects a locked row whose scope hash or set membership changed", async () => {
    const approvalRows = await rows()
    approvalRows[0]!.scopeHash = "sha256:" + "e".repeat(64)
    const tx = {
      $queryRaw: vi.fn(async () => approvalRows.map(row => ({ id: row.id }))),
      agentApproval: { findMany: vi.fn(async () => approvalRows) },
    }
    await expect(loadLockedObjectiveApprovalSetMembers(tx as never,
      { userId, sessionId, expectedTurnId: turnId, approvalId: "approval-1" }, setContent))
      .rejects.toMatchObject({ code: "wait_scope_mismatch" })
  })
})
