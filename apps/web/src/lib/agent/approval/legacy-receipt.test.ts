import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Prisma, PrismaClient } from "@prisma/client"
import type { LegacyReceiptInput } from "./legacy-receipt"

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

afterEach(() => vi.unstubAllEnvs())

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
  }, 10_000)

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

describe("issueLegacyReceipt transaction preparation", () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach((mock) => mock.mockReset())
  })

  it("recomputes the receipt scope from the task linked inside the owner-fenced transaction", async () => {
    const { hashLegacyValue, issueLegacyReceipt } = await import("./legacy-receipt")
    const payload = { jobId: "job_1", applicationTaskId: "application_task_1" }
    const prepareInTransaction = vi.fn(async () => ({ taskId: "application_task_1", payload, material: payload }))

    await issueLegacyReceipt({} as PrismaClient, {
      userId: "user_1",
      sessionId: "session_1",
      turnId: "turn_1",
      toolCallId: "review_1",
      jobId: "job_1",
      action: "review_application",
      title: "Review application",
      body: "Review materials",
      payload: { jobId: "job_1" },
      resource: { jobId: "job_1" },
      material: { jobId: "job_1" },
      revision: 7,
      expiresAt: new Date("2026-10-01T00:00:00.000Z"),
      prepareInTransaction,
    })

    const storeInput = mocks.issueApprovalReceipt.mock.calls[0]?.[1]
    const prepared = await storeInput.prepareInTransaction({} as Prisma.TransactionClient)

    expect(prepareInTransaction).toHaveBeenCalledOnce()
    expect(storeInput.scope).toMatchObject({ turnId: "turn_1", revision: 7 })
    expect(prepared).toMatchObject({ taskId: "application_task_1", payload })
    expect(prepared.scope.materialHash).toBe(await hashLegacyValue("material", payload))
    expect(prepared.scope).toMatchObject({ sessionId: "session_1", turnId: "turn_1", jobId: "job_1", action: "review_application" })
  })
})

describe("Gate receipt replay identity", () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach((mock) => mock.mockReset())
    vi.stubEnv("AGENT_WORKER_SECRET", "test-server-only-shared-secret")
  })

  function gateInput(overrides: Partial<Pick<LegacyReceiptInput, "jobId" | "material" | "answers" | "revision" | "expiresAt" | "executionAttempt" | "scheduledOwnerFence">> = {}) {
    const jobId = overrides.jobId ?? "job_1"
    const executionAttempt = overrides.executionAttempt ?? { id: "execution_1", attemptCount: 4 }
    const scheduledOwnerFence = overrides.scheduledOwnerFence ?? {
      owner: {
        userId: "user_1", sessionId: "session_1", turnId: "turn_1", rootTaskId: "root_task_1", rootAttemptCount: 2,
        turnLeaseOwnerId: "lease_owner_1", turnLeaseVersion: 5,
        executionId: executionAttempt.id, executionAttemptCount: executionAttempt.attemptCount,
      },
      key: "continuation_key_1",
      claimToken: "claim_token_1",
      assertCurrent: async () => true,
    }
    return {
      userId: "user_1",
      sessionId: "session_1",
      turnId: "turn_1",
      toolCallId: "application-review:placeholder",
      jobId,
      action: "review_application" as const,
      title: "Review application",
      body: "Review materials",
      payload: { jobId },
      resource: { jobId },
      material: { resumeHash: "resume-v1", coverLetter: "Dear Acme" },
      answers: null,
      revision: 7,
      expiresAt: new Date("2026-10-01T00:00:00.000Z"),
      executionAttempt,
      scheduledOwnerFence,
      replayMode: "gate-review" as const,
      ...overrides,
    }
  }

  it("derives stable, domain-separated IDs and nonce from the exact Gate replay identity", async () => {
    const { issueLegacyReceipt } = await import("./legacy-receipt")
    const baseOwnerFence = gateInput().scheduledOwnerFence!
    const inputs = [
      gateInput(),
      gateInput({ revision: 8, expiresAt: new Date("2026-10-02T00:00:00.000Z") }),
      gateInput({ executionAttempt: { id: "execution_2", attemptCount: 4 } }),
      gateInput({ executionAttempt: { id: "execution_1", attemptCount: 3 } }),
      gateInput({ scheduledOwnerFence: { ...baseOwnerFence, owner: { ...baseOwnerFence.owner, rootTaskId: "root_task_2" } } }),
      gateInput({ scheduledOwnerFence: { ...baseOwnerFence, owner: { ...baseOwnerFence.owner, rootAttemptCount: 3 } } }),
      gateInput({ jobId: "job_2" }),
      gateInput({ material: { resumeHash: "resume-v2", coverLetter: "Dear Acme" } }),
      gateInput({ answers: { workAuthorization: "yes" } }),
    ]
    for (const input of inputs) await issueLegacyReceipt({} as PrismaClient, input)

    const issued = mocks.issueApprovalReceipt.mock.calls.map((call) => call[1] as {
      approvalId: string; nonce: string; scope: { toolCallId: string; revision: number; expiresAt: Date }
    })
    expect(issued).toHaveLength(9)
    expect(issued[0]?.approvalId).toBe(issued[1]?.approvalId)
    expect(issued[0]?.nonce).toBe(issued[1]?.nonce)
    expect(issued[0]?.scope.toolCallId).toBe(issued[1]?.scope.toolCallId)
    expect(issued[1]?.scope.revision).toBe(8)
    expect(issued[1]?.scope.expiresAt).toEqual(new Date("2026-10-02T00:00:00.000Z"))
    for (const changed of issued.slice(2)) {
      expect(changed.approvalId).not.toBe(issued[0]?.approvalId)
      expect(changed.nonce).not.toBe(issued[0]?.nonce)
    }
    expect(issued[0]?.nonce).toMatch(/^[0-9a-f]{64}$/)
    expect(issued[0]?.nonce).not.toBe(issued[0]?.approvalId)
    expect(mocks.issueApprovalReceipt.mock.calls[0]?.[1]).toMatchObject({
      scheduledOwnerFence: { owner: { rootTaskId: "root_task_1", rootAttemptCount: 2, executionId: "execution_1", executionAttemptCount: 4 } },
    })
  })

  it("accepts execution attempt zero and keeps rotating lease claim data out of the replay identity", async () => {
    const { issueLegacyReceipt } = await import("./legacy-receipt")
    const first = gateInput({ executionAttempt: { id: "execution_1", attemptCount: 0 } })
    const firstOwner = first.scheduledOwnerFence!
    const second = gateInput({
      executionAttempt: { id: "execution_1", attemptCount: 0 },
      scheduledOwnerFence: {
        ...firstOwner,
        owner: { ...firstOwner.owner, turnLeaseOwnerId: "lease_owner_2", turnLeaseVersion: 6 },
        key: "continuation_key_2",
        claimToken: "claim_token_2",
      },
    })
    await issueLegacyReceipt({} as PrismaClient, first)
    await issueLegacyReceipt({} as PrismaClient, second)

    const issued = mocks.issueApprovalReceipt.mock.calls.map(call => call[1] as { approvalId: string; nonce: string })
    expect(issued[1]?.approvalId).toBe(issued[0]?.approvalId)
    expect(issued[1]?.nonce).toBe(issued[0]?.nonce)
  })

  it("fails closed without the existing shared server signing secret", async () => {
    vi.stubEnv("AGENT_WORKER_SECRET", " ")
    const { issueLegacyReceipt } = await import("./legacy-receipt")

    await expect(issueLegacyReceipt({} as PrismaClient, gateInput())).rejects.toThrow("Gate receipt replay signing key is unavailable")
    expect(mocks.issueApprovalReceipt).not.toHaveBeenCalled()
  })
})

describe("issueLegacyReceipt transaction preparation", () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach((mock) => mock.mockReset())
  })

  it("recomputes the receipt scope from the task linked inside the owner-fenced transaction", async () => {
    const { hashLegacyValue, issueLegacyReceipt } = await import("./legacy-receipt")
    const payload = { jobId: "job_1", applicationTaskId: "application_task_1" }
    const prepareInTransaction = vi.fn(async () => ({
      taskId: "application_task_1",
      payload,
      material: payload,
    }))

    await issueLegacyReceipt({} as PrismaClient, {
      userId: "user_1",
      sessionId: "session_1",
      turnId: "turn_1",
      toolCallId: "review_1",
      jobId: "job_1",
      action: "review_application",
      title: "Review application",
      body: "Review materials",
      payload: { jobId: "job_1" },
      resource: { jobId: "job_1" },
      material: { jobId: "job_1" },
      revision: 7,
      expiresAt: new Date("2026-10-01T00:00:00.000Z"),
      prepareInTransaction,
    })

    const storeInput = mocks.issueApprovalReceipt.mock.calls[0]?.[1]
    const prepared = await storeInput.prepareInTransaction({} as Prisma.TransactionClient)

    expect(prepareInTransaction).toHaveBeenCalledOnce()
    expect(storeInput.scope).toMatchObject({ turnId: "turn_1", revision: 7 })
    expect(prepared).toMatchObject({ taskId: "application_task_1", payload })
    expect(prepared.scope.materialHash).toBe(await hashLegacyValue("material", payload))
    expect(prepared.scope).toMatchObject({ sessionId: "session_1", turnId: "turn_1", jobId: "job_1", action: "review_application" })
  })
})
