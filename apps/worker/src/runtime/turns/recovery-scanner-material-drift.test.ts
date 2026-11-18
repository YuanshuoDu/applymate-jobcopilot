import { createHmac } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { hashAgentReceiptValue } from "@jobcopilot/shared"
import { hashApprovalNonce, hashApprovalScope } from "@jobcopilot/agent-protocol"

const recovery = vi.hoisted(() => ({ read: vi.fn(), verify: vi.fn() }))
vi.mock("../subagents/canonical-turn-scheduled-pipeline-context.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../subagents/canonical-turn-scheduled-pipeline-context.js")>(),
  readMaterialDriftRecoveryIntent: recovery.read,
  verifyMaterialDriftRecoveryLineage: recovery.verify,
}))

import { MATERIAL_DRIFT_RECOVERY_INTENT_SCHEMA, scheduledAutomationSnapshotDigest, type MaterialDriftRecoveryIntent } from "../subagents/canonical-turn-scheduled-pipeline-context.js"
import { reclaimExpiredGateRecoveryTurns } from "./recovery-scanner-material-drift.js"

const now = new Date("2026-10-20T12:00:00.000Z")
const owner = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 4,
  turnLeaseOwnerId: "owner-old", turnLeaseVersion: 7, executionId: "execution-1", executionAttemptCount: 2,
}
const secret = "focused-material-recovery-test-secret"
let counter = 0
const snapshot = { schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1", targetRoles: ["engineer"], targetLocations: ["Dublin"],
  minScore: 70, dailyCap: 8, requireApproval: true, autoApply: false }
const intent: MaterialDriftRecoveryIntent = {
  schemaVersion: MATERIAL_DRIFT_RECOVERY_INTENT_SCHEMA, turnId: owner.turnId, userId: owner.userId, sessionId: owner.sessionId, automationId: "automation-1",
  previousTurnId: "previous-turn", previousExecutionId: owner.executionId, previousRecoveryTurnId: null,
  previousGateTaskId: "previous-gate", previousGateAttemptCount: 2, previousRootTaskId: "previous-root", previousRootAttemptCount: 3,
  previousTurnLeaseVersion: 6, previousExecutionAttemptCount: owner.executionAttemptCount - 1, reservedExecutionAttemptCount: owner.executionAttemptCount,
  currentSnapshotDigest: scheduledAutomationSnapshotDigest(snapshot)!, sourceMarker: {
    schemaVersion: "agent-harness.v2.scheduled-prepare-material-drift-terminal.v1", reason: "scheduled_prepare_material_source_changed",
    owner: { userId: owner.userId, sessionId: owner.sessionId, turnId: "previous-turn", rootTaskId: "previous-root", rootAttemptCount: 3,
      turnLeaseOwnerId: "previous-worker", turnLeaseVersion: 6, executionId: owner.executionId,
      executionAttemptCount: owner.executionAttemptCount - 1 },
    gate: { taskId: "previous-gate", leaseOwnerId: "previous-gate-worker", attemptCount: 2 },
    analyzeFingerprintDigest: `sha256:${"a".repeat(64)}`, prepareProofDigest: `sha256:${"b".repeat(64)}`,
    artifactDigest: `sha256:${"c".repeat(64)}`, currentMaterialDigest: `sha256:${"d".repeat(64)}`, proofDigest: `sha256:${"e".repeat(64)}`,
  },
}

async function recoveryGateRow(signedRootAttempt = owner.rootAttemptCount): Promise<Record<string, unknown>> {
  const jobId = `job-${++counter}`, expiresAt = new Date("2026-10-20T13:00:00.000Z")
  const resourceHash = await hashAgentReceiptValue("resource", { jobId })
  const materialHash = await hashAgentReceiptValue("material", { jobId, resume: "fresh-resume" })
  const answersHash = await hashAgentReceiptValue("answers", null)
  const signerOwner = { ...owner, rootAttemptCount: signedRootAttempt }
  const identity = JSON.stringify([1, owner.userId, owner.sessionId, owner.turnId, signerOwner.executionId, signerOwner.executionAttemptCount,
    [signerOwner.rootTaskId, signerOwner.rootAttemptCount, signerOwner.executionId, signerOwner.executionAttemptCount], jobId, "review_application", resourceHash, materialHash, answersHash])
  const derive = (label: string) => createHmac("sha256", secret).update(`applymate.gate-review-replay.v1:${label}\0${identity}`).digest("hex")
  const approvalId = `gate_review_${derive("approval-id")}`, toolCallId = `application-review:${derive("tool-call-id")}`
  const nonceHash = await hashApprovalNonce(derive("receipt-nonce")), revision = 3
  const scopeHash = await hashApprovalScope({ userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
    jobId, toolCallId, action: "review_application", resourceHash, materialHash, answersHash, revision, nonceHash, expiresAt: expiresAt.toISOString() })
  const title = "Review application: Example", body = "Review the job and materials.", impact = { externalSubmission: false, jobId }
  return {
    ...owner, turnSource: "automation", turnExecutionMode: "canonical_task_graph", turnStatus: "waiting_for_approval",
    turnInput: { automationRunMode: "manual", scheduledAutomationSnapshot: snapshot, materialDriftRecovery: intent },
    approvalId, approvalUserId: owner.userId, approvalSessionId: owner.sessionId, approvalTurnId: owner.turnId,
    approvalJobId: jobId, approvalAction: "review_application", approvalStatus: "pending", approvalToolCallId: toolCallId,
    approvalTitle: title, approvalBody: body, approvalImpact: impact, approvalPayloadJobId: jobId,
    resourceHash, materialHash, answersHash, scopeHash, nonceHash, approvalRevision: revision,
    approvalExpiresAt: expiresAt, approvalExpiresAtUtc: expiresAt.toISOString(), decidedAt: null, consumedAt: null,
    waitItemId: `agent-wait:approval:${approvalId}`, waitSessionId: owner.sessionId, waitTurnId: owner.turnId,
    waitType: "approval_request", waitStatus: "started", waitRevision: 0, waitStartedAt: new Date("2026-10-20T11:40:00.000Z"),
    waitContent: { waitKind: "approval", approvalId, toolCallId, action: "review_application", scopeHash, receiptRevision: revision,
      title, body, impact, expiresAt: expiresAt.toISOString(), decision: null, responseAvailable: false }, waitCompletedAt: null,
  }
}

function fakeClient(row: Record<string, unknown>) {
  const calls: Array<[string, unknown[]?]> = []
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push([sql, params])
    if (sql.includes("JOIN LATERAL")) return { rows: [row], rowCount: 1 }
    if (sql.startsWith('UPDATE "agent_turns"')) return { rows: [{ id: owner.turnId, sessionId: owner.sessionId, leaseVersion: 8 }], rowCount: 1 }
    return { rows: [], rowCount: 1 }
  })
  return { client: { query } as unknown as Pick<pg.PoolClient, "query">, calls }
}

describe("material-drift Gate recovery scanner", () => {
  beforeEach(() => {
    vi.stubEnv("AGENT_WORKER_SECRET", secret)
    recovery.read.mockReset()
    recovery.verify.mockReset()
  })
  afterEach(() => vi.unstubAllEnvs())

  it("requires the strict worker lineage verifier even for a current Gate receipt", async () => {
    const row = await recoveryGateRow()
    recovery.read.mockReturnValue({ status: "valid", intent })
    recovery.verify.mockResolvedValue(false)
    const fake = fakeClient(row)

    await expect(reclaimExpiredGateRecoveryTurns(fake.client, now, 5)).resolves.toEqual([])
    expect(recovery.verify).toHaveBeenCalledOnce()
    expect(fake.calls.some(([sql]) => sql.startsWith('UPDATE "agent_turns"'))).toBe(false)
    expect(fake.calls.find(([sql]) => sql.includes("JOIN LATERAL"))?.[0]).toContain("turn.\"input\" ? 'materialDriftRecovery'")
  })

  it("does not turn a malformed JSON marker into scanner recovery authority", async () => {
    const row = await recoveryGateRow()
    recovery.read.mockReturnValue({ status: "invalid" })
    const fake = fakeClient(row)

    await expect(reclaimExpiredGateRecoveryTurns(fake.client, now, 5)).resolves.toEqual([])
    expect(recovery.verify).not.toHaveBeenCalled()
    expect(fake.calls.some(([sql]) => sql.startsWith('UPDATE "agent_turns"'))).toBe(false)
  })

  it("reclaims the same Turn only with verified recovery lineage and its fresh current Gate receipt", async () => {
    const row = await recoveryGateRow()
    recovery.read.mockReturnValue({ status: "valid", intent })
    recovery.verify.mockResolvedValue(true)
    const fake = fakeClient(row)

    await expect(reclaimExpiredGateRecoveryTurns(fake.client, now, 5)).resolves.toEqual([
      { turnId: owner.turnId, sessionId: owner.sessionId, previousLeaseVersion: owner.turnLeaseVersion },
    ])
    expect(recovery.verify).toHaveBeenCalledOnce()
    expect(fake.calls.find(([sql]) => sql.startsWith('UPDATE "agent_turns"'))?.[1]).toEqual([
      owner.turnId, owner.turnLeaseOwnerId, owner.turnLeaseVersion, now,
    ])
  })

  it("does not reuse a previous root attempt approval after the recovery lineage verifies", async () => {
    const row = await recoveryGateRow(owner.rootAttemptCount - 1)
    recovery.read.mockReturnValue({ status: "valid", intent })
    recovery.verify.mockResolvedValue(true)
    const fake = fakeClient(row)

    await expect(reclaimExpiredGateRecoveryTurns(fake.client, now, 5)).resolves.toEqual([])
    expect(recovery.verify).toHaveBeenCalledOnce()
    expect(fake.calls.some(([sql]) => sql.startsWith('UPDATE "agent_turns"'))).toBe(false)
  })
})
