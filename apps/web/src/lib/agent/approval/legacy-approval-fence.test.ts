import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  txTurnFindFirst: vi.fn(),
  txTurnUpdateMany: vi.fn(),
  txItemFindFirst: vi.fn(),
  txItemFindMany: vi.fn(),
  txApprovalFindMany: vi.fn(),
  resolvePendingApprovalInTransaction: vi.fn(),
  appendAgentEventWithOutboxInTransaction: vi.fn(),
}))

vi.mock("./decision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./decision")>()),
  resolvePendingApprovalInTransaction: mocks.resolvePendingApprovalInTransaction,
}))
vi.mock("../session/fact-store", () => ({ appendAgentEventWithOutboxInTransaction: mocks.appendAgentEventWithOutboxInTransaction }))

function fakeDb() {
  const tx = {
    $queryRaw: mocks.queryRaw,
    agentTurn: { findFirst: mocks.txTurnFindFirst, updateMany: mocks.txTurnUpdateMany },
    agentItem: { findFirst: mocks.txItemFindFirst, findMany: mocks.txItemFindMany },
    agentApproval: { findMany: mocks.txApprovalFindMany },
  }
  return { $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)) } as never
}

function sqlText(query: unknown): string {
  if (!query || typeof query !== "object" || !("strings" in query)) return ""
  const strings = (query as { strings?: unknown }).strings
  return Array.isArray(strings) ? strings.join(" ") : ""
}

describe("legacy approval transaction fence", () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach((mock) => mock.mockReset())
    mocks.queryRaw.mockResolvedValue([{ id: "session_1" }])
    mocks.txTurnFindFirst.mockResolvedValue({ id: "turn_1", status: "in_progress" })
    mocks.txTurnUpdateMany.mockResolvedValue({ count: 1 })
    mocks.txItemFindFirst.mockResolvedValue(null)
    mocks.txItemFindMany.mockResolvedValue([{ content: { approvalId: "approval_2" } }])
    mocks.txApprovalFindMany.mockResolvedValue([{ id: "approval_2" }])
  })

  it("fails closed when a terminal Turn wins before the guarded resume update", async () => {
    mocks.txTurnFindFirst.mockResolvedValue({ id: "turn_1", status: "in_progress" })
    mocks.txTurnUpdateMany.mockResolvedValue({ count: 0 })
    const { ApprovalTurnInactiveError, resumeLegacyApprovalTurnInTransaction } = await import("./legacy-approval-fence")
    const db = fakeDb()

    await expect(resumeLegacyApprovalTurnInTransaction(db, {
      sessionId: "session_1", userId: "user_1", turnId: "turn_1",
    })).rejects.toBeInstanceOf(ApprovalTurnInactiveError)

    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.txTurnFindFirst.mock.invocationCallOrder[0])
    expect(mocks.txTurnFindFirst.mock.invocationCallOrder[0]).toBeLessThan(mocks.txTurnUpdateMany.mock.invocationCallOrder[0])
    expect(mocks.txTurnUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "turn_1", sessionId: "session_1", userId: "user_1",
        status: { in: ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"] },
      }),
      data: { status: "in_progress" },
    })
  })

  it("preserves the legacy inactive-Turn error when the shared active check rejects", async () => {
    mocks.txTurnFindFirst.mockResolvedValue({ id: "turn_1", status: "interrupted" })
    const { ApprovalTurnInactiveError, resumeLegacyApprovalTurnInTransaction } = await import("./legacy-approval-fence")
    const result = resumeLegacyApprovalTurnInTransaction(fakeDb(), {
      sessionId: "session_1", userId: "user_1", turnId: "turn_1",
    })

    await expect(result).rejects.toMatchObject({
      code: "approval_turn_inactive",
      message: "Approval turn is no longer active",
    })
    await expect(result).rejects.toBeInstanceOf(ApprovalTurnInactiveError)
    expect(mocks.txTurnUpdateMany).not.toHaveBeenCalled()
  })

  it.each(["aborted", "archived"] as const)("rejects both legacy resolution and Turn resume for a %s session", async () => {
    mocks.queryRaw.mockImplementation(async (query: unknown) => (
      sqlText(query).includes(`"status" NOT IN ('aborted', 'archived')`)
        ? []
        : [{ id: "session_1" }]
    ))
    const { resolveLegacyOnlyInTransaction, resumeLegacyApprovalTurnInTransaction } = await import("./legacy-approval-fence")

    await expect(resumeLegacyApprovalTurnInTransaction(fakeDb(), {
      sessionId: "session_1", userId: "user_1", turnId: "turn_1",
    })).rejects.toMatchObject({ code: "agent_session_not_found" })
    expect(sqlText(mocks.queryRaw.mock.calls[0]?.[0])).toContain(`"status" NOT IN ('aborted', 'archived')`)
    expect(mocks.txTurnFindFirst).not.toHaveBeenCalled()
    expect(mocks.txTurnUpdateMany).not.toHaveBeenCalled()

    mocks.queryRaw.mockClear()
    await expect(resolveLegacyOnlyInTransaction(fakeDb(), {
      approval: {
        id: "approval_1", type: "send_gmail", payload: {}, turnId: "turn_1", toolCallId: "call_1",
        jobId: "job_1", revision: 0, expiresAt: new Date(Date.now() + 60_000),
      },
      userId: "user_1", sessionId: "session_1", decision: "approved",
    }, {})).rejects.toMatchObject({ code: "agent_session_not_found" })
    expect(sqlText(mocks.queryRaw.mock.calls[0]?.[0])).toContain(`"status" NOT IN ('aborted', 'archived')`)
    expect(mocks.txTurnFindFirst).not.toHaveBeenCalled()
    expect(mocks.resolvePendingApprovalInTransaction).not.toHaveBeenCalled()
    expect(mocks.appendAgentEventWithOutboxInTransaction).not.toHaveBeenCalled()
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

  it.each(["interrupted", "cancelled", "failed", "completed", "future_status"] as const)(
    "rejects a legacy receipt when its Turn is %s",
    async (status) => {
      mocks.txTurnFindFirst.mockResolvedValue({ id: "turn_1", status })
      const { resolveLegacyOnlyInTransaction } = await import("./legacy-approval-fence")

      await expect(resolveLegacyOnlyInTransaction(fakeDb(), {
        approval: {
          id: "approval_1", type: "send_gmail", payload: {}, turnId: "turn_1", toolCallId: "call_1",
          jobId: "job_1", revision: 0, expiresAt: new Date(Date.now() + 60_000),
        },
        userId: "user_1", sessionId: "session_1", decision: "approved",
      }, {})).rejects.toMatchObject({
        code: "approval_turn_inactive",
        message: "Approval turn is no longer available",
      })
      expect(mocks.resolvePendingApprovalInTransaction).not.toHaveBeenCalled()
      expect(mocks.appendAgentEventWithOutboxInTransaction).not.toHaveBeenCalled()
    },
  )

  it.each(["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"] as const)(
    "preserves legacy receipt resolution for a live %s Turn",
    async (status) => {
      mocks.txTurnFindFirst.mockResolvedValue({ id: "turn_1", status })
      mocks.txItemFindMany.mockResolvedValue([])
      mocks.txApprovalFindMany.mockResolvedValue([])
      mocks.resolvePendingApprovalInTransaction.mockResolvedValue({
        turnId: "turn_1", taskId: "task_1", type: "send_gmail", scopeHash: null, revision: 1,
      })
      const { resolveLegacyOnlyInTransaction } = await import("./legacy-approval-fence")

      await expect(resolveLegacyOnlyInTransaction(fakeDb(), {
        approval: {
          id: "approval_1", type: "send_gmail", payload: {}, turnId: "turn_1", toolCallId: "call_1",
          jobId: "job_1", revision: 0, expiresAt: new Date(Date.now() + 60_000),
        },
        userId: "user_1", sessionId: "session_1", decision: "approved",
      }, {})).resolves.toEqual({ disposition: "legacy_only", decision: "approved" })
      expect(mocks.resolvePendingApprovalInTransaction).toHaveBeenCalledOnce()
      expect(mocks.appendAgentEventWithOutboxInTransaction).toHaveBeenCalledOnce()
    },
  )
})
