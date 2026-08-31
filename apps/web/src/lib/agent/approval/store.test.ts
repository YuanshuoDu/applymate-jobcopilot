import { describe, expect, it, vi } from "vitest"

import type { Prisma, PrismaClient } from "@prisma/client"
import { hashApprovalNonce, hashApprovalScope } from "@jobcopilot/agent-protocol"

import { consumeApprovalAndReserve, issueApprovalReceipt, validateApproval } from "./store"
import { protocolScope, ApprovalStoreError, type ApprovalScopeInput } from "./types"

const scopeInput: ApprovalScopeInput = {
  userId: "user_1", sessionId: "session_1", turnId: "turn_1", jobId: "job_1", toolCallId: "call_1", action: "submit_application",
  resourceHash: "a".repeat(64), materialHash: "b".repeat(64), answersHash: "c".repeat(64), revision: 3,
  expiresAt: new Date("2026-09-01T00:00:00.000Z"),
}

async function approvalRow(nonce = "nonce_1"): Promise<Prisma.AgentApprovalGetPayload<{}>> {
  const nonceHash = await hashApprovalNonce(nonce)
  const scopeHash = await hashApprovalScope(protocolScope(scopeInput, nonceHash))
  return {
    id: "approval_1", sessionId: scopeInput.sessionId, taskId: "task_1", userId: scopeInput.userId, turnId: scopeInput.turnId,
    toolCallId: scopeInput.toolCallId, jobId: scopeInput.jobId, type: scopeInput.action, status: "approved", title: "Submit",
    body: "Review", impact: null, payload: { jobId: scopeInput.jobId }, resourceHash: scopeInput.resourceHash,
    materialHash: scopeInput.materialHash, answersHash: scopeInput.answersHash, scopeHash, nonceHash, revision: scopeInput.revision,
    expiresAt: scopeInput.expiresAt, decidedAt: new Date("2026-08-31T00:00:00.000Z"), consumedAt: null,
    createdAt: new Date("2026-08-30T00:00:00.000Z"),
  }
}

function mockDb(row: Prisma.AgentApprovalGetPayload<{}>) {
  const tx = {
    $queryRaw: vi.fn(async () => [{ eventSequence: BigInt(9) }]),
    agentSession: { findFirst: vi.fn(async () => ({ id: row.sessionId })) },
    agentTurn: { findFirst: vi.fn(async () => ({ id: row.turnId })) },
    job: { findFirst: vi.fn(async () => ({ id: row.jobId })) },
    agentApproval: {
      findFirst: vi.fn(async () => row),
      create: vi.fn(async ({ data }: { data: Prisma.AgentApprovalCreateArgs["data"] }) => ({ ...row, ...data })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    agentActionReservation: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...data, id: "reservation_1" })) },
    agentEvent: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({ ...row, id: "event_1", sequence: BigInt(9) })) },
    agentOutbox: { create: vi.fn(async () => ({ id: "outbox_1" })) },
  }
  const db = {
    ...tx,
    $transaction: vi.fn(async (work: (transaction: typeof tx) => Promise<unknown>) => work(tx)),
  } as unknown as PrismaClient
  return { db, tx }
}

describe("Web approval receipt store", () => {
  it("issues a scoped receipt and emits only a safe audit payload", async () => {
    const row = await approvalRow()
    const { db, tx } = mockDb(row)
    const result = await issueApprovalReceipt(db, { approvalId: row.id, scope: scopeInput, title: "Submit", body: "Review", payload: { jobId: row.jobId!, sensitiveAnswer: "secret-answer" }, nonce: "nonce_1" })

    expect(result.nonce).toBe("nonce_1")
    expect(tx.agentApproval.create).toHaveBeenCalledWith({ data: expect.objectContaining({ scopeHash: row.scopeHash, nonceHash: row.nonceHash, turnId: row.turnId, jobId: row.jobId }) })
    expect(tx.agentEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: "approval.requested", payload: { approvalId: row.id, action: row.type, scopeHash: row.scopeHash, revision: row.revision } }) })
    const auditCall = (tx.agentEvent.create.mock.calls as unknown as Array<[unknown]>)[0]?.[0] as { data?: { payload?: unknown } } | undefined
    expect(JSON.stringify(auditCall?.data?.payload)).not.toContain("secret-answer")
  })

  it("rejects a cross-job validation attempt", async () => {
    const row = await approvalRow()
    const { db } = mockDb(row)
    await expect(validateApproval(db, row.id, { ...scopeInput, jobId: "job_2", nonce: "nonce_1" }, new Date("2026-08-31T12:00:00.000Z"))).rejects.toMatchObject({ code: "approval_scope_mismatch" })
  })

  it("rejects stale revisions and expired receipts", async () => {
    const row = await approvalRow()
    const { db } = mockDb(row)
    await expect(validateApproval(db, row.id, { ...scopeInput, revision: 4, nonce: "nonce_1" }, new Date("2026-08-31T12:00:00.000Z"))).rejects.toMatchObject({ code: "approval_revision_mismatch" })
    await expect(validateApproval(db, row.id, { ...scopeInput, nonce: "nonce_1" }, new Date("2026-09-01T00:00:00.000Z"))).rejects.toMatchObject({ code: "approval_expired" })
  })

  it("consumes exactly one approved receipt with its external reservation in one transaction", async () => {
    const row = await approvalRow()
    const { db, tx } = mockDb(row)
    const result = await consumeApprovalAndReserve(db, row.id, { ...scopeInput, nonce: "nonce_1" }, { idempotencyKey: "submit:task_1" }, new Date("2026-08-31T12:00:00.000Z"))

    expect(result).toMatchObject({ approvalId: row.id, reservationId: expect.any(String) })
    expect(db.$transaction).toHaveBeenCalledOnce()
    expect(tx.agentApproval.updateMany).toHaveBeenCalledWith({ where: expect.objectContaining({ status: "approved", scopeHash: row.scopeHash, nonceHash: row.nonceHash }), data: expect.objectContaining({ status: "consumed" }) })
    expect(tx.agentActionReservation.create).toHaveBeenCalledWith({ data: expect.objectContaining({ approvalId: row.id, idempotencyKey: "submit:task_1", status: "reserved" }) })
    expect(tx.agentEvent.create).toHaveBeenCalledTimes(2)
  })

  it("maps a conditional update race to an already-consumed error", async () => {
    const row = await approvalRow()
    const { db, tx } = mockDb(row)
    tx.agentApproval.updateMany.mockResolvedValue({ count: 0 })
    await expect(consumeApprovalAndReserve(db, row.id, { ...scopeInput, nonce: "nonce_1" }, { idempotencyKey: "submit:task_1" })).rejects.toBeInstanceOf(ApprovalStoreError)
    await expect(consumeApprovalAndReserve(db, row.id, { ...scopeInput, nonce: "nonce_1" }, { idempotencyKey: "submit:task_2" })).rejects.toMatchObject({ code: "approval_already_consumed" })
  })
})
