import type { PrismaClient } from "@prisma/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ObjectiveApplicationApprovalSetDecisionInput } from "./objective-application-approval-set-decision"

const deps = vi.hoisted(() => ({ decision: vi.fn(), verifySource: vi.fn(), recordApproved: vi.fn() }))
vi.mock("./objective-application-approval-set-decision", () => ({
  decideObjectiveApplicationApprovalSetMemberInTransaction: deps.decision,
}))
vi.mock("./objective-application-review-source", () => ({ verifyObjectiveApplicationReviewSource: deps.verifySource }))
vi.mock("./objective-application-approved-intent", () => ({ recordObjectiveApplicationApprovedIntent: deps.recordApproved }))

import { decideObjectiveApplicationReviewMember } from "./objective-application-review-decision-service"

const input: Omit<ObjectiveApplicationApprovalSetDecisionInput, "expectedScopeHash"> = {
  approvalId: "approval-1", userId: "user-1", sessionId: "session-1", expectedTurnId: "turn-1",
  expectedRevision: 4, expectedReceiptRevision: 2, clientMessageId: "decision-1", decision: "approved",
  now: new Date("2030-01-01T00:00:00.000Z"),
}
const scopeHash = "a".repeat(64)

beforeEach(() => { deps.decision.mockReset(); deps.verifySource.mockReset(); deps.recordApproved.mockReset() })

describe("decideObjectiveApplicationReviewMember", () => {
  it("rejects when the owner-scoped review receipt is absent", async () => {
    const { database, tx } = fakeDatabase(null)
    await expect(decideObjectiveApplicationReviewMember(database, input)).rejects.toMatchObject({ code: "wait_not_found" })
    expect(tx.agentApproval.findFirst).toHaveBeenCalledWith({ where: {
      id: input.approvalId, userId: input.userId, sessionId: input.sessionId, turnId: input.expectedTurnId, type: "review_application",
    }, select: { scopeHash: true } })
    expect(deps.decision).not.toHaveBeenCalled()
  })

  it("fails closed for a malformed stored scope hash", async () => {
    const { database } = fakeDatabase({ scopeHash: "invalid" })
    await expect(decideObjectiveApplicationReviewMember(database, input)).rejects.toMatchObject({ code: "wait_scope_mismatch" })
    expect(deps.decision).not.toHaveBeenCalled()
  })

  it("forwards the persisted scope and both verifiers on the same transaction", async () => {
    const { database, tx } = fakeDatabase({ scopeHash }), result = { disposition: "resolved" }
    deps.decision.mockResolvedValue(result)
    const untrusted = { ...input, expectedScopeHash: "client-supplied" } as unknown as typeof input
    await expect(decideObjectiveApplicationReviewMember(database, untrusted)).resolves.toBe(result)
    expect(database.$transaction).toHaveBeenCalledTimes(1)
    expect(deps.decision).toHaveBeenCalledWith(tx, { ...input, expectedScopeHash: scopeHash }, {
      verifySource: deps.verifySource, recordApprovedHandoff: deps.recordApproved,
    })
  })
})

function fakeDatabase(receipt: unknown) {
  const tx = { agentApproval: { findFirst: vi.fn(async () => receipt) } }
  const database = { $transaction: vi.fn(async (callback: (value: unknown) => Promise<unknown>) => callback(tx)) }
  return { database: database as unknown as PrismaClient, tx }
}
