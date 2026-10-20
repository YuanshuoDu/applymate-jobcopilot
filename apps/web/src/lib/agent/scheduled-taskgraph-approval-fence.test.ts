import { createHmac } from "node:crypto"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { hashApprovalNonce, hashApprovalScope } from "@jobcopilot/agent-protocol"
import { hashAgentReceiptValue } from "@jobcopilot/shared"
import { protocolScope } from "./approval/types"
import { hasScheduledTaskGraphGateProof, scheduledTaskGraphGateProofIsValid } from "./scheduled-taskgraph-approval-fence"
import type { ScheduledTaskGraphPipelineOwner } from "./scheduled-taskgraph-pipeline-checkpoint"

const owner: ScheduledTaskGraphPipelineOwner = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 3,
  turnLeaseOwnerId: "worker-1", turnLeaseVersion: 7, executionId: "execution-1", executionAttemptCount: 0,
}
const key = "continuation-key", claimToken = "claim-token-1", secret = "test-gate-fence-secret"
const savedSecret = process.env.AGENT_WORKER_SECRET
const impact = { externalSubmission: false, jobId: "job-1" }
const approvalTime = new Date("2026-10-20T12:00:00.000Z")

function stateFor(stage = "gate", stateOwner = owner, stateKey = key, stateToken = claimToken) {
  return { nextStage: stage,
    scheduledTaskGraphClaim: { schemaVersion: "agent-harness.v2.scheduled-pipeline-claim.v1", key: stateKey,
      claimToken: stateToken, owner: stateOwner, claimedAt: "2026-10-20T11:50:00.000Z", leaseExpiresAt: "2026-10-20T12:10:00.000Z" },
    scheduledTaskGraphContinuation: { schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1", key: stateKey,
      owner: stateOwner, snapshotDigest: `sha256:${"a".repeat(64)}`, graphRevision: 9, evidenceDigest: "b".repeat(64) } }
}

async function receiptFor(receiptOwner = owner, values: Record<string, unknown> = {}, jobId = "job-1", answers: unknown = null) {
  const resourceHash = "1".repeat(64), materialHash = "2".repeat(64), answersHash = await hashAgentReceiptValue("answers", answers)
  const revision = 12, expiresAt = new Date("2026-10-20T12:30:00.000Z")
  const toolCallIdentity = JSON.stringify([1, receiptOwner.userId, receiptOwner.sessionId, receiptOwner.turnId,
    receiptOwner.executionId, receiptOwner.executionAttemptCount,
    [receiptOwner.rootTaskId, receiptOwner.rootAttemptCount, receiptOwner.executionId, receiptOwner.executionAttemptCount],
    jobId, "review_application", resourceHash, materialHash, answersHash])
  const derive = (label: string) => createHmac("sha256", secret)
    .update(`applymate.gate-review-replay.v1:${label}\0${toolCallIdentity}`).digest("hex")
  const nonceHash = await hashApprovalNonce(derive("receipt-nonce"))
  const toolCallId = `application-review:${derive("tool-call-id")}`
  const base = {
    id: `gate_review_${derive("approval-id")}`, userId: receiptOwner.userId, sessionId: receiptOwner.sessionId,
    turnId: receiptOwner.turnId, toolCallId, jobId, type: "review_application", status: "pending",
    title: "Review application: Example · Engineer", body: "Review the job and prepared materials.", impact: { ...impact, jobId },
    payload: { jobId, applicationTaskId: "application-task-1" }, resourceHash, materialHash, answersHash, nonceHash,
    revision, expiresAt, decidedAt: null, consumedAt: null, ...values,
  }
  const scope = protocolScope({ userId: base.userId, sessionId: base.sessionId, turnId: base.turnId, jobId: base.jobId,
    toolCallId: base.toolCallId, action: "review_application", resourceHash: base.resourceHash as string,
    materialHash: base.materialHash as string, answersHash: base.answersHash as string,
    revision: base.revision as number, expiresAt: base.expiresAt as Date }, nonceHash)
  return { ...base, scopeHash: await hashApprovalScope(scope) }
}

function waitFor(approval: Awaited<ReturnType<typeof receiptFor>>, values: Record<string, unknown> = {}) {
  const content = {
    waitKind: "approval", approvalId: approval.id, toolCallId: approval.toolCallId, action: "review_application",
    title: approval.title, body: approval.body, impact: approval.impact, scopeHash: approval.scopeHash,
    receiptRevision: approval.revision, expiresAt: approval.expiresAt.toISOString(), decision: null,
  }
  return { id: `agent-wait:approval:${approval.id}`, sessionId: approval.sessionId, turnId: approval.turnId,
    type: "approval_request", status: "started", revision: 0, startedAt: approvalTime, completedAt: null,
    content: { ...content, ...values } }
}

function proof(approval: unknown, waitItem: unknown, values: Record<string, unknown> = {}) {
  return { owner, key, claimToken, executionStatus: "running", checkpoint: "gate", state: stateFor(), approval, waitItem,
    now: approvalTime, ...values }
}

async function decidedApproval() {
  const decidedAt = new Date("2026-10-20T12:01:00.000Z")
  const approval = await receiptFor(owner, { status: "approved", decidedAt })
  const waitItem = waitFor(approval, { decision: "approved", responseAvailable: true, respondedAt: decidedAt.toISOString() })
  return { approval, waitItem: { ...waitItem, status: "completed", revision: 1, completedAt: decidedAt } }
}

describe("scheduled TaskGraph Gate approval fence", () => {
  beforeEach(() => { process.env.AGENT_WORKER_SECRET = secret })
  afterAll(() => { if (savedSecret === undefined) delete process.env.AGENT_WORKER_SECRET; else process.env.AGENT_WORKER_SECRET = savedSecret })

  it.each(["gate", "execute", "audit", "completed"])("accepts an exact pending Gate receipt through %s", async stage => {
    const approval = await receiptFor(), waitItem = waitFor(approval)
    await expect(scheduledTaskGraphGateProofIsValid(proof(approval, waitItem, { checkpoint: stage, state: stateFor(stage) }))).resolves.toBe(true)
  })

  it("accepts an approved receipt only with its explicit canonical wait decision", async () => {
    const { approval, waitItem } = await decidedApproval()
    await expect(scheduledTaskGraphGateProofIsValid(proof(approval, waitItem))).resolves.toBe(true)
    await expect(scheduledTaskGraphGateProofIsValid(proof(approval, { ...waitItem,
      content: { ...(waitItem as { content: object }).content, decision: null } }))).resolves.toBe(false)
  })

  it("rejects a self-consistent receipt bound to non-null answers in both owner fences", async () => {
    const answers = { firstName: "Example", email: "candidate@example.test" }
    const approval = await receiptFor(owner, {}, "job-1", answers), waitItem = waitFor(approval)
    expect(approval.answersHash).toBe(await hashAgentReceiptValue("answers", answers))

    await expect(scheduledTaskGraphGateProofIsValid(proof(approval, waitItem))).resolves.toBe(false)
    const reader = { agentApproval: { findMany: vi.fn().mockResolvedValue([approval]) },
      agentItem: { findFirst: vi.fn().mockResolvedValue(waitItem) } }
    await expect(hasScheduledTaskGraphGateProof({ reader: reader as never, owner, key, claimToken, executionStatus: "running",
      checkpoint: "gate", state: stateFor(), now: approvalTime })).resolves.toBe(false)
  })

  it.each([
    ["expired receipt", () => receiptFor(owner, { expiresAt: new Date("2026-10-20T11:59:00.000Z") }), (approval: Awaited<ReturnType<typeof receiptFor>>) => waitFor(approval)],
    ["consumed receipt", () => receiptFor(owner, { status: "consumed", consumedAt: approvalTime }), (approval: Awaited<ReturnType<typeof receiptFor>>) => waitFor(approval)],
    ["rejected receipt", () => receiptFor(owner, { status: "rejected", decidedAt: approvalTime }), (approval: Awaited<ReturnType<typeof receiptFor>>) => waitFor(approval)],
    ["changed root attempt", () => receiptFor({ ...owner, rootAttemptCount: 2 }), (approval: Awaited<ReturnType<typeof receiptFor>>) => waitFor(approval)],
    ["changed execution attempt", () => receiptFor({ ...owner, executionAttemptCount: 1 }), (approval: Awaited<ReturnType<typeof receiptFor>>) => waitFor(approval)],
    ["tampered material hash", async () => { const row = await receiptFor(); return { ...row, materialHash: "5".repeat(64) } },
      (approval: Awaited<ReturnType<typeof receiptFor>>) => waitFor(approval)],
    ["tampered scope hash", async () => { const row = await receiptFor(); return { ...row, scopeHash: "6".repeat(64) } },
      (approval: Awaited<ReturnType<typeof receiptFor>>) => waitFor(approval)],
    ["tampered tool call", async () => { const row = await receiptFor(); return { ...row, toolCallId: "other-call" } },
      (approval: Awaited<ReturnType<typeof receiptFor>>) => waitFor(approval)],
  ] as const)("rejects %s", async (_name, makeApproval, makeItem) => {
    const approval = await makeApproval(), waitItem = makeItem(approval)
    await expect(scheduledTaskGraphGateProofIsValid(proof(approval, waitItem))).resolves.toBe(false)
  })

  it.each([
    ["missing item", null],
    ["wrong item id", (approval: Awaited<ReturnType<typeof receiptFor>>) => ({ ...waitFor(approval), id: "other" })],
    ["foreign Turn", (approval: Awaited<ReturnType<typeof receiptFor>>) => ({ ...waitFor(approval), turnId: "other-turn" })],
    ["foreign session", (approval: Awaited<ReturnType<typeof receiptFor>>) => ({ ...waitFor(approval), sessionId: "other-session" })],
    ["wrong item type", (approval: Awaited<ReturnType<typeof receiptFor>>) => ({ ...waitFor(approval), type: "question" })],
    ["mismatched scope", (approval: Awaited<ReturnType<typeof receiptFor>>) => waitFor(approval, { scopeHash: "7".repeat(64) })],
    ["mismatched revision", (approval: Awaited<ReturnType<typeof receiptFor>>) => waitFor(approval, { receiptRevision: approval.revision + 1 })],
    ["pending item with a decision", (approval: Awaited<ReturnType<typeof receiptFor>>) => waitFor(approval, { decision: "approved" })],
    ["approved item with a rejected decision", async (approval: Awaited<ReturnType<typeof receiptFor>>) => {
      const decided = await decidedApproval()
      return { ...decided.waitItem, id: `agent-wait:approval:${approval.id}`, content: { ...(decided.waitItem as { content: object }).content, approvalId: approval.id, decision: "rejected" } }
    }],
  ] as const)("rejects %s", async (_name, makeItem) => {
    const approval = await receiptFor(), waitItem = typeof makeItem === "function" ? await makeItem(approval) : makeItem
    await expect(scheduledTaskGraphGateProofIsValid(proof(approval, waitItem))).resolves.toBe(false)
  })

  it.each([
    ["checkpoint mismatch", { checkpoint: "execute" }],
    ["unsupported Prepare checkpoint", { checkpoint: "prepare", state: stateFor("prepare") }],
    ["execution no longer running", { executionStatus: "completed" }],
    ["wrong claim key", { state: stateFor("gate", owner, "other-key") }],
    ["wrong claim token", { state: stateFor("gate", owner, key, "other-token") }],
    ["wrong claim owner", { state: stateFor("gate", { ...owner, rootAttemptCount: 2 }) }],
    ["extra claim field", { state: { ...stateFor(), scheduledTaskGraphClaim: { ...stateFor().scheduledTaskGraphClaim, extra: true } } }],
    ["wrong continuation owner", { state: { ...stateFor(), scheduledTaskGraphContinuation: { ...stateFor().scheduledTaskGraphContinuation, owner: { ...owner, executionAttemptCount: 1 } } } }],
  ] as const)("rejects %s", async (_name, values) => {
    const approval = await receiptFor(), waitItem = waitFor(approval)
    await expect(scheduledTaskGraphGateProofIsValid(proof(approval, waitItem, values))).resolves.toBe(false)
  })

  it("fails closed without the stable signing key", async () => {
    const approval = await receiptFor(), waitItem = waitFor(approval)
    delete process.env.AGENT_WORKER_SECRET
    await expect(scheduledTaskGraphGateProofIsValid(proof(approval, waitItem))).resolves.toBe(false)
  })

  it("loads persisted receipts and only accepts a matching canonical item", async () => {
    const approval = await receiptFor(), waitItem = waitFor(approval)
    const reader = { agentApproval: { findMany: vi.fn().mockResolvedValue([approval]) },
      agentItem: { findFirst: vi.fn().mockResolvedValue(waitItem) } }
    await expect(hasScheduledTaskGraphGateProof({ reader: reader as never, owner, key, claimToken, executionStatus: "running",
      checkpoint: "gate", state: stateFor(), now: approvalTime })).resolves.toBe(true)
    expect(reader.agentApproval.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      turnId: owner.turnId,
    } }))
    expect(reader.agentItem.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
      id: `agent-wait:approval:${approval.id}`,
    } }))
  })

  it("accepts multiple current-attempt receipts when one has the canonical wait item", async () => {
    const projected = await receiptFor(), unprojected = await receiptFor(owner, {}, "job-2")
    const itemById = new Map([[`agent-wait:approval:${projected.id}`, waitFor(projected)]])
    const reader = { agentApproval: { findMany: vi.fn().mockResolvedValue([projected, unprojected]) },
      agentItem: { findFirst: vi.fn(async ({ where }: { where: { id: string } }) => itemById.get(where.id)) } }
    await expect(hasScheduledTaskGraphGateProof({ reader: reader as never, owner, key, claimToken, executionStatus: "running",
      checkpoint: "execute", state: stateFor("execute"), now: approvalTime })).resolves.toBe(true)
  })

  it.each(["rejected sibling receipt", "mismatched sibling wait item", "approval ID-only sibling receipt", "changed-type sibling receipt",
    "changed-session sibling receipt", "wrong-type sibling wait item", "wrong-turn sibling wait item"])("fails closed when a valid receipt has a %s", async siblingFailure => {
    const valid = await receiptFor()
    const sibling = siblingFailure === "rejected sibling receipt"
      ? await receiptFor(owner, { status: "rejected", decidedAt: approvalTime }, "job-2")
      : await receiptFor(owner, {}, "job-2")
    const invalidSibling = siblingFailure === "approval ID-only sibling receipt" ? { ...sibling, id: "tampered-approval-id" }
      : siblingFailure === "changed-type sibling receipt" ? { ...sibling, type: "submit_application" }
      : siblingFailure === "changed-session sibling receipt" ? { ...sibling, sessionId: "other-session" } : sibling
    const siblingItem = siblingFailure === "mismatched sibling wait item" ? waitFor(sibling, { scopeHash: "8".repeat(64) })
      : siblingFailure === "wrong-type sibling wait item" ? { ...waitFor(sibling), type: "question" }
        : siblingFailure === "wrong-turn sibling wait item" ? { ...waitFor(sibling), turnId: "other-turn" } : waitFor(sibling)
    const itemById = new Map([[`agent-wait:approval:${valid.id}`, waitFor(valid)], [`agent-wait:approval:${sibling.id}`,
      siblingItem]])
    const reader = { agentApproval: { findMany: vi.fn().mockResolvedValue([valid, invalidSibling]) },
      agentItem: { findFirst: vi.fn(async ({ where }: { where: { id: string } }) => itemById.get(where.id)) } }
    await expect(hasScheduledTaskGraphGateProof({ reader: reader as never, owner, key, claimToken, executionStatus: "running",
      checkpoint: "execute", state: stateFor("execute"), now: approvalTime })).resolves.toBe(false)
  })

  it.each(["type", "sessionId", "turnId"] as const)("rejects a current-attempt receipt with changed %s metadata", async field => {
    const approval = await receiptFor(), waitItem = waitFor(approval)
    const tampered = { ...approval, [field]: field === "type" ? "submit_application" : `other-${field}` }
    await expect(scheduledTaskGraphGateProofIsValid(proof(tampered, waitItem))).resolves.toBe(false)
  })
})
