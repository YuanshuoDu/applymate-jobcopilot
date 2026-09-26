import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  consumeApprovalAndReserve: vi.fn(),
  issueApprovalReceipt: vi.fn(),
  validatePendingApprovalReceipt: vi.fn(),
  decideApproval: vi.fn(),
  resolvePendingApprovalInTransaction: vi.fn(),
  appendAgentEventWithOutboxInTransaction: vi.fn(),
  rootItemFindFirst: vi.fn(),
  rootTurnFindFirst: vi.fn(),
  txItemFindFirst: vi.fn(),
  txItemFindMany: vi.fn(),
  txApprovalFindMany: vi.fn(),
  txTurnFindFirst: vi.fn(),
  queryRaw: vi.fn(),
}))

vi.mock("./store", () => ({
  consumeApprovalAndReserve: mocks.consumeApprovalAndReserve,
  issueApprovalReceipt: mocks.issueApprovalReceipt,
  validatePendingApprovalReceipt: mocks.validatePendingApprovalReceipt,
}))
vi.mock("../broker/store", () => ({ decideApproval: mocks.decideApproval }))
vi.mock("./decision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./decision")>()),
  resolvePendingApprovalInTransaction: mocks.resolvePendingApprovalInTransaction,
}))
vi.mock("../session/fact-store", () => ({ appendAgentEventWithOutboxInTransaction: mocks.appendAgentEventWithOutboxInTransaction }))

function approvalRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "approval_1",
    type: "send_gmail",
    payload: {},
    turnId: "turn_1",
    toolCallId: "call_1",
    jobId: "job_1",
    revision: 0,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  }
}

function fakeDb() {
  const tx = {
    $queryRaw: mocks.queryRaw,
    agentTurn: { findFirst: mocks.txTurnFindFirst },
    agentItem: { findFirst: mocks.txItemFindFirst, findMany: mocks.txItemFindMany },
    agentApproval: { findMany: mocks.txApprovalFindMany },
  }
  return {
    $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)),
    agentTurn: { findFirst: mocks.rootTurnFindFirst },
    agentItem: { findFirst: mocks.rootItemFindFirst },
  } as never
}

describe("resolveLegacyApproval same-Turn fence", () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach((mock) => mock.mockReset())
    mocks.rootItemFindFirst.mockResolvedValue(null)
    mocks.rootTurnFindFirst.mockResolvedValue({ id: "turn_1", status: "in_progress", revision: 0 })
    mocks.queryRaw.mockResolvedValue([{ id: "session_1" }])
    mocks.txTurnFindFirst.mockResolvedValue({ id: "turn_1", status: "in_progress" })
    mocks.txItemFindFirst.mockResolvedValue(null)
    mocks.txItemFindMany.mockResolvedValue([])
    mocks.txApprovalFindMany.mockResolvedValue([])
    mocks.resolvePendingApprovalInTransaction.mockResolvedValue({
      id: "approval_1", sessionId: "session_1", taskId: null, userId: "user_1", turnId: "turn_1",
      toolCallId: "call_1", type: "send_gmail", status: "approved", scopeHash: "scope", revision: 0, expiresAt: new Date(),
    })
    mocks.decideApproval.mockResolvedValue({ waitKind: "approval", waitId: "approval_1", itemId: "agent-wait:approval:approval_1", turnId: "turn_1", disposition: "resolved", status: "approved", nextTurnRevision: 1, sequence: "1" })
  })

  it("delegates a matching canonical Item to decideApproval", async () => {
    mocks.rootItemFindFirst.mockResolvedValue({ id: "agent-wait:approval:approval_1", revision: 2 })
    const { resolveLegacyApproval } = await import("./legacy-receipt")

    const result = await resolveLegacyApproval(fakeDb(), { approval: approvalRecord(), userId: "user_1", sessionId: "session_1", decision: "approved" })

    expect(result).toMatchObject({ disposition: "canonical_wait", decision: "approved" })
    expect(mocks.decideApproval).toHaveBeenCalledTimes(1)
    expect(mocks.resolvePendingApprovalInTransaction).not.toHaveBeenCalled()
  })

  it("fails closed for another active approval Item in the same Turn", async () => {
    mocks.txItemFindMany.mockResolvedValue([{ content: { approvalId: "approval_2" } }])
    mocks.txApprovalFindMany.mockResolvedValue([{ id: "approval_2" }])
    const { resolveLegacyApproval, ApprovalWaitActiveError } = await import("./legacy-receipt")

    const promise = resolveLegacyApproval(fakeDb(), { approval: approvalRecord(), userId: "user_1", sessionId: "session_1", decision: "approved" })

    await expect(promise).rejects.toBeInstanceOf(ApprovalWaitActiveError)
    await expect(promise).rejects.toMatchObject({ code: "approval_wait_active" })
    expect(mocks.resolvePendingApprovalInTransaction).not.toHaveBeenCalled()
    expect(mocks.appendAgentEventWithOutboxInTransaction).not.toHaveBeenCalled()
  })

  it("keeps the legacy-only path when no other active Item exists", async () => {
    const beforeLegacyOnlyResolve = vi.fn()
    const { resolveLegacyApproval } = await import("./legacy-receipt")

    const result = await resolveLegacyApproval(fakeDb(), { approval: approvalRecord(), userId: "user_1", sessionId: "session_1", decision: "rejected" }, { beforeLegacyOnlyResolve })

    expect(result).toEqual({ disposition: "legacy_only", decision: "rejected" })
    expect(beforeLegacyOnlyResolve).toHaveBeenCalledTimes(1)
    expect(mocks.resolvePendingApprovalInTransaction).toHaveBeenCalledTimes(1)
    expect(mocks.appendAgentEventWithOutboxInTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: "approval.resolved", outboxTopic: "agent.session.event" }))
  })

  it("fails closed when multiple active approvals are present", async () => {
    mocks.txItemFindMany.mockResolvedValue([
      { content: { approvalId: "approval_2" } },
      { content: { approvalId: "approval_3" } },
    ])
    mocks.txApprovalFindMany.mockResolvedValue([{ id: "approval_2" }, { id: "approval_3" }])
    const { resolveLegacyApproval } = await import("./legacy-receipt")

    await expect(resolveLegacyApproval(fakeDb(), { approval: approvalRecord(), userId: "user_1", sessionId: "session_1", decision: "rejected" })).rejects.toMatchObject({ code: "approval_wait_active" })
    expect(mocks.resolvePendingApprovalInTransaction).not.toHaveBeenCalled()
    expect(mocks.appendAgentEventWithOutboxInTransaction).not.toHaveBeenCalled()
  })
})
