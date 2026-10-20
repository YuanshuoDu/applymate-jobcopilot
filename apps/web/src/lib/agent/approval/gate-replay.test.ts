import { describe, expect, it } from "vitest"
import type { Prisma } from "@prisma/client"
import { hashApprovalNonce, hashApprovalScope } from "@jobcopilot/agent-protocol"

import { ApprovalStoreError, protocolScope, type ApprovalScopeInput } from "./types"
import { recoverGateReviewReplay, type ReplayReceiptExpectation } from "./gate-replay"

const nonce = "a".repeat(64)
const originalScope: ApprovalScopeInput = {
  userId: "user_1",
  sessionId: "session_1",
  turnId: "turn_1",
  jobId: "job_1",
  toolCallId: "application-review:stable",
  action: "review_application",
  resourceHash: "b".repeat(64),
  materialHash: "c".repeat(64),
  answersHash: "d".repeat(64),
  revision: 3,
  expiresAt: new Date("2026-10-01T00:00:00.000Z"),
}

async function pendingReceipt(): Promise<Prisma.AgentApprovalGetPayload<{}>> {
  const nonceHash = await hashApprovalNonce(nonce)
  const scopeHash = await hashApprovalScope(protocolScope(originalScope, nonceHash))
  return {
    id: "approval_1",
    sessionId: originalScope.sessionId,
    taskId: "application_task_1",
    userId: originalScope.userId,
    turnId: originalScope.turnId,
    toolCallId: originalScope.toolCallId,
    jobId: originalScope.jobId,
    type: originalScope.action,
    status: "pending",
    title: "Review application",
    body: "Review materials",
    impact: { externalSubmission: false },
    payload: { jobId: originalScope.jobId, applicationTaskId: "application_task_1" },
    resourceHash: originalScope.resourceHash,
    materialHash: originalScope.materialHash,
    answersHash: originalScope.answersHash,
    scopeHash,
    nonceHash,
    revision: originalScope.revision,
    expiresAt: originalScope.expiresAt,
    decidedAt: null,
    consumedAt: null,
    createdAt: new Date("2026-09-30T00:00:00.000Z"),
  }
}

async function expectation(scope = { ...originalScope, revision: 9, expiresAt: new Date("2026-10-02T00:00:00.000Z") }): Promise<ReplayReceiptExpectation> {
  return {
    approvalId: "approval_1",
    nonce,
    nonceHash: await hashApprovalNonce(nonce),
    scope,
    taskId: null,
    taskPayloadField: "applicationTaskId",
    title: "Review application",
    body: "Review materials",
    impact: { externalSubmission: false },
    payload: { jobId: originalScope.jobId },
  }
}

describe("Gate receipt replay recovery", () => {
  it("returns the original pending revision and expiry without re-preparing the receipt", async () => {
    const row = await pendingReceipt()

    const recovered = await recoverGateReviewReplay(row, await expectation(), new Date("2026-09-30T23:30:00.000Z"))

    expect(recovered.nonce).toBe(nonce)
    expect(recovered.approval).toMatchObject({
      id: row.id,
      status: "pending",
      scope: { revision: originalScope.revision, expiresAt: originalScope.expiresAt.toISOString() },
    })
  })

  it("rejects a replay whose reviewed material digest changed", async () => {
    const row = await pendingReceipt()
    const changed = await expectation({ ...originalScope, materialHash: "e".repeat(64), revision: 9, expiresAt: new Date("2026-10-02T00:00:00.000Z") })

    await expect(recoverGateReviewReplay(row, changed, new Date("2026-10-01T12:00:00.000Z")))
      .rejects.toMatchObject({ code: "approval_scope_mismatch" } satisfies Partial<ApprovalStoreError>)
  })
})
