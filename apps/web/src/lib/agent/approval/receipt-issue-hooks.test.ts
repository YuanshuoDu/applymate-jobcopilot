import { describe, expect, it, vi } from "vitest"

import type { Prisma } from "@prisma/client"

import { acquireReceiptSourceFence, issueApprovalReceipt, validateReceiptSource } from "./receipt-issue-hooks"
import type { ScheduledReceiptSourceHooks } from "./receipt-issue-owner"
import type { ApprovalScopeInput } from "./types"
import { createAnalyzeSourceChangedErrorWithClaims } from "../stages/analyze-model-input"

const issueMocks = vi.hoisted(() => ({ lockSession: vi.fn(), refreshAttempt: vi.fn(), appendEvent: vi.fn(), projectWait: vi.fn() }))
vi.mock("../session/v2-turn", () => ({ lockOpenSession: issueMocks.lockSession }))
vi.mock("../execution-control", async importOriginal => ({
  ...(await importOriginal<typeof import("../execution-control")>()), refreshAgentExecutionAttempt: issueMocks.refreshAttempt,
}))
vi.mock("../session/fact-store", () => ({ appendAgentEventWithOutboxInTransaction: issueMocks.appendEvent }))
vi.mock("../broker/item-projector", () => ({ projectApprovalWaitInTransaction: issueMocks.projectWait }))

const scope: ApprovalScopeInput = {
  userId: "user_1", sessionId: "session_1", turnId: "turn_1", jobId: "job_1", toolCallId: "call_1", action: "submit_application",
  resourceHash: "a".repeat(64), materialHash: "b".repeat(64), answersHash: "c".repeat(64), revision: 3,
  expiresAt: new Date(Date.now() + 60_000),
}

describe("receipt issue source hooks", () => {
  it("runs the paired hooks with the caller transaction and exact scope", async () => {
    const tx = {} as Prisma.TransactionClient
    const hooks: ScheduledReceiptSourceHooks = {
      acquireFence: vi.fn(async () => undefined),
      validateFinalSource: vi.fn(async () => undefined),
    }

    await acquireReceiptSourceFence(tx, scope.userId, hooks)
    await validateReceiptSource(tx, scope, hooks)

    expect(hooks.acquireFence).toHaveBeenCalledOnce()
    expect(hooks.acquireFence).toHaveBeenCalledWith(tx, scope.userId)
    expect(hooks.validateFinalSource).toHaveBeenCalledOnce()
    expect(hooks.validateFinalSource).toHaveBeenCalledWith(tx, scope)
  })

  it("leaves hook-omitted calls unchanged and propagates hook errors", async () => {
    const tx = {} as Prisma.TransactionClient
    await expect(acquireReceiptSourceFence(tx, scope.userId, undefined)).resolves.toBeUndefined()
    await expect(validateReceiptSource(tx, scope, undefined)).resolves.toBeUndefined()

    const fenceError = Object.assign(new Error("source fence failed"), { code: "P2002" })
    const sourceError = new Error("source validation failed")
    const hooks: ScheduledReceiptSourceHooks = {
      acquireFence: vi.fn(async () => { throw fenceError }),
      validateFinalSource: vi.fn(async () => { throw sourceError }),
    }

    await expect(acquireReceiptSourceFence(tx, scope.userId, hooks)).rejects.toBe(fenceError)
    await expect(validateReceiptSource(tx, scope, hooks)).rejects.toBe(sourceError)
  })

  it("checks the scheduled Gate owner and Analyze source before preparing a new receipt", async () => {
    const order: string[] = []
    const sourceError = createAnalyzeSourceChangedErrorWithClaims([{ jobId: "job_1", analysisFenceAt: "2026-09-01T00:00:00.000Z" }])
    const assertCurrent = vi.fn(async () => { order.push("source-and-proof-validation"); throw sourceError })
    const scheduledOwnerFence = { owner: { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: "root_1",
      rootAttemptCount: 1, turnLeaseOwnerId: "lease_1", turnLeaseVersion: 2, executionId: "execution_1", executionAttemptCount: 4 },
      key: "continuation_1", claimToken: "claim_1", gateTaskId: "gate_1", assertCurrent }
    const scheduledSourceHooks: ScheduledReceiptSourceHooks = {
      acquireFence: vi.fn(async () => { order.push("source-fence") }),
      validateFinalSource: vi.fn(async () => { order.push("job-source-validation") }),
    }
    const prepareInTransaction = vi.fn(async () => { order.push("prepare-materials"); return { scope } })
    issueMocks.lockSession.mockReset().mockImplementation(async () => { order.push("session-lock") })
    issueMocks.refreshAttempt.mockReset().mockResolvedValue(true)
    const tx = { agentApproval: { findFirst: vi.fn(), create: vi.fn() } }
    let committed = false
    const db = { $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => {
      const result = await callback(tx)
      committed = true
      return result
    }) } as never

    await expect(issueApprovalReceipt(db, { scope, title: "Review", body: "Review this application", payload: { jobId: scope.jobId },
      projectWait: false, executionAttempt: { id: "execution_1", attemptCount: 4 }, scheduledOwnerFence, scheduledSourceHooks,
      prepareInTransaction } as never)).rejects.toBe(sourceError)

    expect(order).toEqual(["source-fence", "session-lock", "source-and-proof-validation"])
    expect(prepareInTransaction).not.toHaveBeenCalled()
    expect(tx.agentApproval.findFirst).not.toHaveBeenCalled()
    expect(tx.agentApproval.create).not.toHaveBeenCalled()
    expect(committed).toBe(false)
  })

  it("revalidates source and owner before unique-conflict receipt replay lookup", async () => {
    const order: string[] = []
    let ownerChecks = 0
    const sourceError = createAnalyzeSourceChangedErrorWithClaims([{ jobId: "job_1", analysisFenceAt: "2026-09-01T00:00:00.000Z" }])
    const assertCurrent = vi.fn(async () => {
      ownerChecks += 1
      order.push(`owner-source-proof-${ownerChecks}`)
      if (ownerChecks === 2) throw sourceError
      return true
    })
    const scheduledOwnerFence = { owner: { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: "root_1",
      rootAttemptCount: 1, turnLeaseOwnerId: "lease_1", turnLeaseVersion: 2, executionId: "execution_1", executionAttemptCount: 4 },
      key: "continuation_1", claimToken: "claim_1", gateTaskId: "gate_1", assertCurrent }
    const scheduledSourceHooks: ScheduledReceiptSourceHooks = {
      acquireFence: vi.fn(async () => { order.push("source-fence") }),
      validateFinalSource: vi.fn(async () => { order.push("final-job-source") }),
    }
    const uniqueError = Object.assign(new Error("unique"), { code: "P2002" })
    const existingRead = vi.fn(async () => { order.push("receipt-read"); return null })
    const create = vi.fn(async () => { order.push("receipt-create"); throw uniqueError })
    const tx = { $queryRaw: vi.fn(async () => [{ id: scope.turnId, status: "in_progress", revision: scope.revision }]),
      job: { findFirst: vi.fn(async () => ({ id: scope.jobId })) }, agentApproval: { findFirst: existingRead, create },
    }
    issueMocks.lockSession.mockReset().mockImplementation(async () => { order.push("session-lock") })
    issueMocks.refreshAttempt.mockReset().mockResolvedValue(true)
    const db = { $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)) } as never

    await expect(issueApprovalReceipt(db, { scope, approvalId: "approval_1", nonce: "nonce_1", replayExisting: {}, title: "Review", body: "Review this application",
      payload: { jobId: scope.jobId }, projectWait: false, executionAttempt: { id: "execution_1", attemptCount: 4 }, scheduledOwnerFence,
      scheduledSourceHooks } as never)).rejects.toBe(sourceError)

    expect(ownerChecks).toBe(2)
    expect(existingRead).toHaveBeenCalledOnce()
    expect(create).toHaveBeenCalledOnce()
    expect(order.slice(-3)).toEqual(["source-fence", "session-lock", "owner-source-proof-2"])
    expect(order.filter(event => event === "receipt-read")).toHaveLength(1)
    expect(order.filter(event => event === "final-job-source")).toHaveLength(1)
    expect(scheduledSourceHooks.validateFinalSource).toHaveBeenCalledOnce()
  })
})
