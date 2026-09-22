import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  txTurnFindFirst: vi.fn(),
  txItemFindFirst: vi.fn(),
  txItemFindMany: vi.fn(),
  txApprovalFindMany: vi.fn(),
  resolvePendingApprovalInTransaction: vi.fn(),
  appendAgentEventWithOutboxInTransaction: vi.fn(),
}))

vi.mock("./decision", () => ({ resolvePendingApprovalInTransaction: mocks.resolvePendingApprovalInTransaction }))
vi.mock("../session/fact-store", () => ({ appendAgentEventWithOutboxInTransaction: mocks.appendAgentEventWithOutboxInTransaction }))

function fakeDb() {
  const tx = {
    $queryRaw: mocks.queryRaw,
    agentTurn: { findFirst: mocks.txTurnFindFirst },
    agentItem: { findFirst: mocks.txItemFindFirst, findMany: mocks.txItemFindMany },
    agentApproval: { findMany: mocks.txApprovalFindMany },
  }
  return { $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)) } as never
}

describe("legacy approval transaction fence", () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach((mock) => mock.mockReset())
    mocks.queryRaw.mockResolvedValue([{ id: "session_1" }])
    mocks.txTurnFindFirst.mockResolvedValue({ id: "turn_1" })
    mocks.txItemFindFirst.mockResolvedValue(null)
    mocks.txItemFindMany.mockResolvedValue([{ content: { approvalId: "approval_2" } }])
    mocks.txApprovalFindMany.mockResolvedValue([{ id: "approval_2" }])
  })

  it("returns the stable active-wait code before any legacy transition side effect", async () => {
    const { ApprovalWaitActiveError, resolveLegacyOnlyInTransaction } = await import("./legacy-approval-fence")
    const promise = resolveLegacyOnlyInTransaction(fakeDb(), {
      approval: {
        id: "approval_1", type: "send_gmail", payload: {}, turnId: "turn_1", toolCallId: "call_1",
        jobId: "job_1", revision: 0, expiresAt: new Date(Date.now() + 60_000),
      },
      userId: "user_1", sessionId: "session_1", decision: "approved",
    }, {})

    await expect(promise).rejects.toBeInstanceOf(ApprovalWaitActiveError)
    await expect(promise).rejects.toMatchObject({ code: "approval_wait_active" })
    expect(mocks.resolvePendingApprovalInTransaction).not.toHaveBeenCalled()
    expect(mocks.appendAgentEventWithOutboxInTransaction).not.toHaveBeenCalled()
  })
})
