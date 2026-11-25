import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { hashApprovalScope, objectiveApplicationApprovalSetItemId } from "@jobcopilot/agent-protocol"
import {
  buildObjectiveApplicationResumeWitness, buildObjectiveApplicationReviewMemberProof, canonicalJson,
} from "@jobcopilot/shared"
import { protocolScope } from "../approval/types"
import { hashArtifactContent } from "../artifacts/hash"
import { canonicalTaskGraphItemId } from "./final-task-graph-source-detail"
import { readObjectiveJourneyReportApprovals } from "./objective-journey-report-approvals"

const userId = "user-report", sessionId = "session-report", sourceTurnId = "source-report", rootTaskId = "root-source"
const reviewTurnId = "review-report", reviewRootId = "root-review", graphRevision = 19
const ordinals = [1, 2, 4, 5, 6, 7]
const expiresAt = new Date("2026-12-01T12:00:00.000Z")

describe("Objective journey report approval bindings", () => {
  it("keeps a verified sparse slot when a known sibling receipt is malformed", async () => {
    const f = await fixture()
    const result = await readObjectiveJourneyReportApprovals(f.tx as never, f.source)
    expect(result[1]).toMatchObject({ slotOrdinal: 2, reviewStatus: "rejected", reviewTurnId })
    expect(result[0]?.reviewStatus).toBe("unknown")
    expect(result[2]?.reviewStatus).toBe("not_requested")
    expect(f.tx.agentApproval.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      id: { not: f.approvalId }, AND: [
        { payload: { path: ["setId"], equals: f.setId } },
        { payload: { path: ["slotOrdinal"], equals: 2 } },
      ],
    }) }))
  })

  it("marks only the slot ambiguous when another receipt claims the same persisted ordinal", async () => {
    const f = await fixture(true)
    const result = await readObjectiveJourneyReportApprovals(f.tx as never, f.source)
    expect(result[1]).toMatchObject({ slotOrdinal: 2, reviewStatus: "unknown", reviewTurnId })
    expect(result[3]?.reviewStatus).toBe("unknown")
  })
})

async function fixture(conflict = false) {
  const graphItemId = canonicalTaskGraphItemId(rootTaskId)
  const selection = { schema: "agent-harness.v2.objective-application-review-intent.v1", sourceTurnId, rootTaskId,
    graphItemId, graphRevision, slotOrdinals: ordinals }
  const setId = "objective-review-" + createHash("sha256").update(`objective-application-review-set.v1\0${sessionId}\0${reviewTurnId}`).digest("hex").slice(0, 40)
  const memberId = (ordinal: number) => `objective-review:${setId}:${ordinal}`
  const intentHash = createHash("sha256").update(canonicalJson(selection)).digest("hex")
  const members = ordinals.map(slotOrdinal => ({ slotOrdinal, approvalId: memberId(slotOrdinal) }))
  const input = { clientMessageId: "command-review", goal: "Review the selected completed Objective materials for application preparation.",
    content: [{ type: "text", text: "Review the selected verified materials. This does not authorize an application or submission." }],
    intent: { kind: "objective_application_review", version: 1, selection } }
  const turn = { id: reviewTurnId, userId, sessionId, source: "user", executionMode: "canonical_task_graph",
    status: "waiting_for_approval", rootTaskId: reviewRootId, input }
  const slot = sourceSlot(2), proof = await memberProof(slot)
  const nonceHash = `sha256:${"e".repeat(64)}`, toolCallId = `objective_review_application:${setId}:2`
  const resourceHash = hashArtifactContent({ kind: "review_application", userId, sessionId, jobId: slot.jobId,
    applicationTaskId: "application-task-2", slotOrdinal: 2 }).slice(7)
  const answersHash = hashArtifactContent({ kind: "review_application", formAnswers: null }).slice(7)
  const scopeHash = await hashApprovalScope(protocolScope({ userId, sessionId, turnId: reviewTurnId, jobId: slot.jobId!, toolCallId,
    action: "review_application", resourceHash, materialHash: proof.materialProofHash, answersHash, revision: 3, expiresAt }, nonceHash))
  const approvalId = memberId(2)
  const receipt = { id: approvalId, userId, sessionId, turnId: reviewTurnId, taskId: "application-task-2", jobId: slot.jobId,
    toolCallId, type: "review_application", status: "rejected", revision: 3, expiresAt, decidedAt: new Date(), consumedAt: null,
    payload: { schema: "objective-application-approval-set-member.v1", setId, sourceTurnId, slotOrdinal: 2, proof },
    resourceHash, materialHash: proof.materialProofHash, answersHash, scopeHash, nonceHash }
  const malformedSibling = { id: memberId(4), userId, sessionId, turnId: reviewTurnId, taskId: "application-task-4",
    jobId: "job-4", toolCallId: `objective_review_application:${setId}:4`, type: "review_application", status: "rejected",
    revision: 3, expiresAt, decidedAt: new Date(), consumedAt: null, payload: { schema: "malformed" } }
  const competing = conflict ? [{ id: "alternate-claim", payload: { setId, slotOrdinal: 2 } }] : []
  const source = { userId, sessionId, sourceTurnId, rootTaskId, finalItemId: "source-final", graphRevision,
    sourceCounts: { discoveredJobs: { knownCount: 8, coverage: "complete" }, analyzedJobs: { knownCount: 8, coverage: "complete" } },
    slots: Array.from({ length: 8 }, (_, index) => sourceSlot(index + 1)) } as const
  const tx = {
    agentTurn: { findMany: async () => [turn] },
    agentInput: { findMany: async () => [{ targetTurnId: reviewTurnId, clientMessageId: input.clientMessageId, delivery: "follow_up",
      status: "accepted", acceptedSequence: 10n, cancelledAt: null }] },
    subAgentTask: { findMany: async () => [{ id: reviewRootId, status: "waiting_for_user", failureReason: null,
      leaseOwner: null, leaseExpiresAt: null, completedAt: null }] },
    agentItem: { findMany: async () => [{ id: objectiveApplicationApprovalSetItemId(setId), sessionId, turnId: reviewTurnId,
      stepId: null, taskId: null, type: "approval_request", status: "started", phase: "commentary", revision: 0,
      content: { schema: "objective-application-approval-set.v1", waitKind: "approval_set", setId, sourceTurnId,
        intentHash, expiresAt: expiresAt.toISOString(), members }, completedAt: null }] },
    agentApproval: { findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
      const where = args.where
      if (where.id === approvalId) return [receipt]
      if (where.id === memberId(4)) return [malformedSibling]
      const clauses = where.AND as readonly { payload?: { path?: readonly string[]; equals?: unknown } }[] | undefined
      if (clauses?.some(clause => clause.payload?.path?.join(".") === "slotOrdinal" && clause.payload.equals === 2)) return competing
      return []
    }) },
    applicationTaskEvent: { findMany: async () => [] },
  }
  return { tx, source, approvalId, setId }
}

function sourceSlot(ordinal: number) {
  return { ordinal, tailoringStatus: "ready" as const, sourceReady: true, jobId: `job-${ordinal}`,
    job: { company: `Company ${ordinal}`, role: `Role ${ordinal}` }, writerTaskId: `writer-${ordinal}`, reviewerTaskId: `reviewer-${ordinal}` }
}

async function memberProof(slot: ReturnType<typeof sourceSlot>) {
  const resumeWitness = buildObjectiveApplicationResumeWitness({ userId, jobId: slot.jobId!, resumeId: `resume-${slot.ordinal}`,
    finalResumeAssignmentRevision: 2, materialRevision: 4, material: { name: "Tailored", content: { skills: ["verified"] },
      templateId: "resume", templateOptions: null, kind: "adapted", targetJobId: slot.jobId, parentResumeId: "resume-base", basicsDetached: false } })!
  return buildObjectiveApplicationReviewMemberProof({ resumeWitness, source: { jobId: slot.jobId!, sourceTurnId, rootTaskId,
    graphItemId: canonicalTaskGraphItemId(rootTaskId), graphRevision, finalItemId: "source-final", slotOrdinal: slot.ordinal,
    writerTaskId: slot.writerTaskId!, reviewerTaskId: slot.reviewerTaskId!, reviewerToolCallId: `review-call-${slot.ordinal}`,
    reviewHash: `sha256:${"a".repeat(64)}`, artifactId: `artifact-${slot.ordinal}`, version: 2,
    contentHash: `sha256:${"b".repeat(64)}`, sourceDigest: `sha256:${"c".repeat(64)}` } })!
}
