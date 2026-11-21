import { beforeEach, describe, expect, it, vi } from "vitest"
import { hashApprovalNonce, hashApprovalScope } from "@jobcopilot/agent-protocol"
import { hashReviewedApplicationMaterialProof } from "@jobcopilot/shared"
import { protocolScope, type ApprovalScopeInput } from "./approval/types.js"
import type { Pool } from "pg"
import { SessionPauseRequestedError } from "./session-gate.js"
import type { TurnLease } from "./turns/lease.js"

const mocks = vi.hoisted(() => ({
  fence: vi.fn(), readProof: vi.fn(), readContext: vi.fn(), issue: vi.fn(),
  state: {
    order: [] as string[], task: {} as Record<string, unknown>, approval: null as Record<string, unknown> | null,
    scope: null as Record<string, unknown> | null, binding: null as Record<string, unknown> | null,
    wait: null as Record<string, unknown> | null, requestEvent: null as Record<string, unknown> | null,
    startedEvent: null as Record<string, unknown> | null, issueCalls: 0, paused: false, admissionParams: [] as unknown[],
  },
}))
vi.mock("../db/source-material-fence.js", () => ({ acquireSourceMaterialFence: mocks.fence }))
vi.mock("./selected-job-reviewed-artifact-read.js", () => ({ readSelectedJobReviewedArtifactWithClient: mocks.readProof }))
vi.mock("./subagents/selected-job-artifact-context.js", () => ({ loadSelectedJobArtifactContext: mocks.readContext }))
vi.mock("./approval/pg-store.js", () => ({ createPgApprovalStore: () => ({ issueInTransaction: mocks.issue }) }))

import { issueOrReplayReviewedApplicationReview } from "./reviewed-application-review-issuance.js"

const proof = {
  jobId: "job-1", sourceTurnId: "source-turn-1", rootTaskId: "source-root-1", graphRevision: 7,
  writerTaskId: "writer-1", reviewerTaskId: "reviewer-1", reviewerToolCallId: "review-call-1",
  reviewHash: `sha256:${"a".repeat(64)}`, artifactId: "draft-1", version: 2,
  contentHash: `sha256:${"b".repeat(64)}`, sourceDigest: `sha256:${"c".repeat(64)}`,
  content: "private reviewed cover letter",
}
const intent = { kind: "reviewed_application_review", version: 1, sourceTurnId: proof.sourceTurnId, jobId: proof.jobId }
let now: Date
let lease: TurnLease

function freshTask(overrides: Record<string, unknown> = {}) {
  return { id: "application-1", userId: "user-1", sessionId: "session-1", jobId: "job-1", resumeId: "resume-1", status: "waiting_for_user",
    checkpoint: "materials_ready", workerTaskId: null, fillTurnId: null, fillTurnSessionId: null,
    fillTurnUserId: null, startedAt: null, completedAt: null, ...overrides }
}
function input(overrides: Partial<{ rootTaskId: string; intent: unknown; now: Date }> = {}) {
  return { pool: { connect: vi.fn(async () => client()) } as unknown as Pool, lease, rootTaskId: overrides.rootTaskId ?? "review-root-1",
    intent: overrides.intent ?? intent, now: overrides.now ?? now }
}
function client() {
  return { release: vi.fn(), query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    mocks.state.order.push(sql)
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 1 }
    if (sql.includes("set_config")) return { rows: [{ set_config: "user-1" }], rowCount: 1 }
    if (sql.includes("FROM \"agent_sessions\" AS session")) {
      mocks.state.admissionParams = [...params]
      return { rows: mocks.state.paused ? [] : [{ id: "session-1" }], rowCount: mocks.state.paused ? 0 : 1 }
    }
    if (sql.includes("FROM \"agent_sessions\"")) return { rows: [{ id: "session-1" }], rowCount: 1 }
    if (sql.includes("SELECT \"id\" FROM \"agent_turns\"")) return { rows: [{ id: lease.turnId }], rowCount: 1 }
    if (sql.includes("SELECT \"rootTaskId\"")) return { rows: [{ rootTaskId: "review-root-1", input: { intent }, revision: 4 }], rowCount: 1 }
    if (sql.includes("FROM \"sub_agent_tasks\"")) return { rows: [{ id: "review-root-1", status: "running", role: "orchestrator", taskType: "root",
      depth: 0, attemptCount: 1, leaseOwner: lease.ownerId, leaseExpiresAt: lease.leaseExpiresAt,
      interruptRequestedAt: null, failureReason: null, completedAt: null, closedAt: null, nextAttemptAt: null }], rowCount: 1 }
    if (sql.includes("FROM \"Job\"")) return { rows: [{ id: "job-1" }], rowCount: 1 }
    if (sql.includes("INSERT INTO \"application_tasks\"")) return { rows: [], rowCount: 1 }
    if (sql.includes("FROM \"application_tasks\"")) return { rows: [mocks.state.task], rowCount: 1 }
    if (sql.includes("FROM \"agent_approvals\"")) return { rows: mocks.state.approval ? [mocks.state.approval] : [], rowCount: mocks.state.approval ? 1 : 0 }
    if (sql.includes("INSERT INTO \"application_task_events\"")) {
      mocks.state.binding = JSON.parse(String(params[4])) as Record<string, unknown>
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes("FROM \"application_task_events\"")) {
      if (sql.includes("\"type\"=$2")) return { rows: mocks.state.binding ? [{ taskId: "application-1", type: "reviewed_application_review_issued", actor: "worker",
        body: "Reviewed application approval binding recorded.", data: mocks.state.binding }] : [], rowCount: mocks.state.binding ? 1 : 0 }
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes("FROM \"agent_events\"")) {
      const event = params[2] === "approval.requested" ? mocks.state.requestEvent : mocks.state.startedEvent
      return { rows: event ? [event] : [], rowCount: event ? 1 : 0 }
    }
    if (sql.includes("FROM \"agent_items\"")) return { rows: mocks.state.wait ? [mocks.state.wait] : [], rowCount: mocks.state.wait ? 1 : 0 }
    throw new Error(`unexpected test query: ${sql}`)
  }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  now = new Date()
  lease = { userId: "user-1", sessionId: "session-1", turnId: "review-turn-1", ownerId: "worker-1", leaseVersion: 5,
    leaseStartedAt: new Date(now.getTime() - 1_000), leaseExpiresAt: new Date(now.getTime() + 60_000) }
  mocks.state.order = []; mocks.state.task = freshTask(); mocks.state.approval = null; mocks.state.scope = null
  mocks.state.binding = null; mocks.state.wait = null; mocks.state.requestEvent = null; mocks.state.startedEvent = null
  mocks.state.issueCalls = 0; mocks.state.paused = false; mocks.state.admissionParams = []
  mocks.fence.mockImplementation(async (_client: unknown, _users: unknown) => { mocks.state.order.push("source-fence") })
  mocks.readContext.mockResolvedValue({ baseResumeId: "resume-1", preparation: { jobId: proof.jobId, sourceDigest: proof.sourceDigest } })
  mocks.readProof.mockResolvedValue({ ...proof })
  mocks.issue.mockImplementation(async (_client: unknown, raw: unknown) => {
    mocks.state.issueCalls += 1
    const issue = raw as { approvalId: string; taskId: string; scope: ApprovalScopeInput; title: string; body: string; payload: unknown }
    mocks.state.scope = issue.scope as unknown as Record<string, unknown>
    const nonceHash = await hashApprovalNonce("private-approval-nonce")
    const scopeHash = await hashApprovalScope(protocolScope(issue.scope, nonceHash))
    const impact = { externalSubmission: false, jobId: issue.scope.jobId }
    const approval = { id: issue.approvalId, type: "review_application", status: "pending", payload: issue.payload,
      scopeHash, title: issue.title, body: issue.body, impact,
      scope: { ...issue.scope, nonceHash, expiresAt: issue.scope.expiresAt.toISOString() } }
    mocks.state.approval = { ...approval, userId: issue.scope.userId, sessionId: issue.scope.sessionId, turnId: issue.scope.turnId,
      taskId: issue.taskId, jobId: issue.scope.jobId, toolCallId: issue.scope.toolCallId, resourceHash: issue.scope.resourceHash,
      materialHash: issue.scope.materialHash, answersHash: issue.scope.answersHash, nonceHash, revision: issue.scope.revision,
      expiresAt: issue.scope.expiresAt, decidedAt: null, consumedAt: null }
    const waitId = `agent-wait:approval:${issue.approvalId}`
    mocks.state.requestEvent = { sessionId: lease.sessionId, turnId: lease.turnId, itemId: null, taskId: issue.taskId,
      type: "approval.requested", actor: "orchestrator", correlationId: issue.approvalId,
      idempotencyKey: `approval:${issue.approvalId}:requested`, payload: { approvalId: issue.approvalId, action: "review_application", scopeHash, revision: issue.scope.revision } }
    mocks.state.startedEvent = { sessionId: lease.sessionId, turnId: lease.turnId, itemId: waitId, taskId: issue.taskId,
      type: "item.started", actor: "orchestrator", correlationId: waitId, idempotencyKey: `agent-wait:${waitId}:started`,
      payload: { itemId: waitId, waitKind: "approval", approvalId: issue.approvalId, toolCallId: issue.scope.toolCallId } }
    mocks.state.wait = { id: waitId, sessionId: lease.sessionId, turnId: lease.turnId, stepId: null, taskId: null,
      type: "approval_request", status: "started", phase: "commentary", revision: 0, startedAt: now, completedAt: null,
      content: { waitKind: "approval", approvalId: issue.approvalId, toolCallId: issue.scope.toolCallId, action: "review_application",
        title: issue.title, body: issue.body, impact, scopeHash, receiptRevision: issue.scope.revision,
        expiresAt: issue.scope.expiresAt.toISOString(), decision: null } }
    return { approval, nonce: "DO_NOT_RETURN" }
  })
})

describe("issueOrReplayReviewedApplicationReview", () => {
  it("preserves the typed pause denial immediately after locking the Session", async () => {
    mocks.state.paused = true
    await expect(issueOrReplayReviewedApplicationReview(input())).rejects.toBeInstanceOf(SessionPauseRequestedError)
    const admissionSql = mocks.state.order.find(sql => sql.includes("pause_request"))
    expect(admissionSql).toContain('session."status" = \'running\'')
    expect(admissionSql).toContain('pause_request."type" = \'session.pause_requested\'')
    expect(mocks.state.admissionParams).toEqual([lease.sessionId, lease.userId, lease.turnId])
    expect(mocks.issue).not.toHaveBeenCalled()
    expect(mocks.readContext).not.toHaveBeenCalled()
    expect(mocks.readProof).not.toHaveBeenCalled()
    expect(mocks.state.order).toContain("ROLLBACK")
  })

  it("fences source, validates lease/root/proof, and issues one private-bound canonical Wait", async () => {
    const result = await issueOrReplayReviewedApplicationReview(input())
    expect(result).toEqual({ status: "issued", approvalId: "reviewed-application-review:review-turn-1",
      waitItemId: "agent-wait:approval:reviewed-application-review:review-turn-1" })
    expect(mocks.state.order[0]).toBe("BEGIN")
    expect(mocks.state.order.indexOf("source-fence")).toBeLessThan(mocks.state.order.findIndex(sql => sql.includes("FROM \"agent_sessions\"")))
    expect(mocks.issue).toHaveBeenCalledTimes(1)
    const rootSql = mocks.state.order.find(sql => sql.includes('FROM "sub_agent_tasks" AS root'))
    expect(rootSql).toContain('JOIN "agent_sessions" AS session')
    expect(rootSql).toContain('JOIN "agent_turns" AS turn')
    expect(rootSql).toContain('FOR UPDATE OF root')
    expect(rootSql).not.toContain('root."userId"')
    const issue = mocks.issue.mock.calls[0]?.[1] as { projectWait?: boolean; taskId: string; scope: ApprovalScopeInput; payload: unknown }
    expect(issue.projectWait).toBeUndefined()
    expect(issue.taskId).toBe("application-1")
    expect(issue.scope.action).toBe("review_application")
    expect(issue.scope.materialHash).toBe(await hashReviewedApplicationMaterialProof({
      jobId: proof.jobId, sourceTurnId: proof.sourceTurnId, rootTaskId: proof.rootTaskId, graphRevision: proof.graphRevision,
      writerTaskId: proof.writerTaskId, reviewerTaskId: proof.reviewerTaskId, reviewerToolCallId: proof.reviewerToolCallId,
      reviewHash: proof.reviewHash, artifactId: proof.artifactId, version: proof.version, contentHash: proof.contentHash, sourceDigest: proof.sourceDigest,
    }))
    expect(mocks.state.binding).toMatchObject({ schemaVersion: "agent-harness.v2.reviewed-application-review-binding.v1",
      approvalId: "reviewed-application-review:review-turn-1", reviewTurnId: lease.turnId, proof: expect.not.objectContaining({ content: expect.anything() }) })
    expect(mocks.state.binding?.receiptScope).not.toHaveProperty("scopeHash")
    expect(JSON.stringify(mocks.state.binding)).not.toContain("private reviewed cover letter")
    expect(JSON.stringify(result)).not.toMatch(/nonce|sourceTurnId|contentHash|private reviewed/i)
  })

  it("replays the same pending Wait after scope-hash rotation without issuing another receipt", async () => {
    await issueOrReplayReviewedApplicationReview(input())
    const savedScope = mocks.state.scope as unknown as ApprovalScopeInput
    const rotatedNonceHash = await hashApprovalNonce("rotated-private-nonce")
    const rotatedScopeHash = await hashApprovalScope(protocolScope(savedScope, rotatedNonceHash))
    mocks.state.approval!.nonceHash = rotatedNonceHash
    mocks.state.approval!.scopeHash = rotatedScopeHash
    mocks.state.wait!.content = { ...(mocks.state.wait!.content as object), scopeHash: rotatedScopeHash }
    await expect(issueOrReplayReviewedApplicationReview(input())).resolves.toMatchObject({ status: "waiting" })
    expect(mocks.issue).toHaveBeenCalledTimes(1)
  })

  it.each(["approved", "rejected"] as const)("returns the persisted %s decision without reissuing", async decision => {
    await issueOrReplayReviewedApplicationReview(input())
    const decidedAt = new Date(now.getTime() + 500)
    mocks.state.approval!.status = decision
    mocks.state.approval!.decidedAt = decidedAt
    mocks.state.wait!.status = "completed"; mocks.state.wait!.revision = 1; mocks.state.wait!.completedAt = decidedAt
    mocks.state.wait!.content = { ...(mocks.state.wait!.content as object), decision, responseAvailable: true, respondedAt: decidedAt.toISOString() }
    await expect(issueOrReplayReviewedApplicationReview(input({ now: decidedAt }))).resolves.toMatchObject({ status: decision })
    expect(mocks.issue).toHaveBeenCalledTimes(1)
  })

  it("replays a rejection from its private binding when selected material has since disappeared", async () => {
    await issueOrReplayReviewedApplicationReview(input())
    const decidedAt = new Date(now.getTime() + 500)
    mocks.state.approval!.status = "rejected"; mocks.state.approval!.decidedAt = decidedAt
    mocks.state.wait!.status = "completed"; mocks.state.wait!.revision = 1; mocks.state.wait!.completedAt = decidedAt
    mocks.state.wait!.content = { ...(mocks.state.wait!.content as object), decision: "rejected", responseAvailable: true,
      respondedAt: decidedAt.toISOString() }
    mocks.readContext.mockRejectedValue(new Error("selected_job_material_missing"))
    mocks.readProof.mockRejectedValue(new Error("selected_job_material_missing"))
    await expect(issueOrReplayReviewedApplicationReview(input({ now: decidedAt }))).resolves.toMatchObject({ status: "rejected" })
    expect(mocks.readContext).toHaveBeenCalledTimes(1)
    expect(mocks.readProof).toHaveBeenCalledTimes(1)
    expect(mocks.issue).toHaveBeenCalledTimes(1)
  })

  it("does not replay even a valid rejection after the ApplicationTask enters a fill attempt", async () => {
    await issueOrReplayReviewedApplicationReview(input())
    const decidedAt = new Date(now.getTime() + 500)
    mocks.state.approval!.status = "rejected"; mocks.state.approval!.decidedAt = decidedAt
    mocks.state.wait!.status = "completed"; mocks.state.wait!.revision = 1; mocks.state.wait!.completedAt = decidedAt
    mocks.state.wait!.content = { ...(mocks.state.wait!.content as object), decision: "rejected", responseAvailable: true,
      respondedAt: decidedAt.toISOString() }
    mocks.state.task = freshTask({ workerTaskId: "unexpected-fill-attempt" })
    await expect(issueOrReplayReviewedApplicationReview(input({ now: decidedAt }))).resolves.toEqual({ status: "denied" })
    expect(mocks.readContext).toHaveBeenCalledTimes(1)
    expect(mocks.readProof).toHaveBeenCalledTimes(1)
    expect(mocks.issue).toHaveBeenCalledTimes(1)
  })

  it("denies mismatched closed intent, a stale proof, or an existing cross-session task", async () => {
    await expect(issueOrReplayReviewedApplicationReview(input({ intent: { ...intent, extra: true } }))).resolves.toEqual({ status: "denied" })
    expect(mocks.issue).not.toHaveBeenCalled()
    mocks.readProof.mockResolvedValueOnce(null)
    await expect(issueOrReplayReviewedApplicationReview(input())).resolves.toEqual({ status: "denied" })
    expect(mocks.issue).not.toHaveBeenCalled()
    mocks.readContext.mockResolvedValueOnce({ baseResumeId: "resume-1", preparation: { jobId: proof.jobId, sourceDigest: `sha256:${"9".repeat(64)}` } })
    await expect(issueOrReplayReviewedApplicationReview(input())).resolves.toEqual({ status: "denied" })
    expect(mocks.issue).not.toHaveBeenCalled()
    mocks.state.task = freshTask({ resumeId: "other-resume" })
    await expect(issueOrReplayReviewedApplicationReview(input())).resolves.toEqual({ status: "denied" })
    expect(mocks.issue).not.toHaveBeenCalled()
    mocks.state.task = freshTask({ sessionId: "other-session" })
    await expect(issueOrReplayReviewedApplicationReview(input())).resolves.toEqual({ status: "denied" })
    expect(mocks.issue).not.toHaveBeenCalled()
  })
})
