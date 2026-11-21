import { describe, expect, it, vi } from "vitest"

import type { Prisma } from "@prisma/client"

import { acquireReceiptSourceFence, validateReceiptSource } from "./receipt-issue-hooks"
import type { ScheduledReceiptSourceHooks } from "./receipt-issue-owner"
import type { ApprovalScopeInput } from "./types"

const scope: ApprovalScopeInput = {
  userId: "user_1", sessionId: "session_1", turnId: "turn_1", jobId: "job_1", toolCallId: "call_1", action: "submit_application",
  resourceHash: "a".repeat(64), materialHash: "b".repeat(64), answersHash: "c".repeat(64), revision: 3,
  expiresAt: new Date("2026-09-01T01:00:00.000Z"),
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
})
