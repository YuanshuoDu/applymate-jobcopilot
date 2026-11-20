import { describe, expect, it, vi } from "vitest"
import type { Prisma } from "@prisma/client"

import { resolvePendingApprovalInTransaction } from "./decision"
import { waitItemId } from "../broker/item-ids"

const NOW = new Date("2026-09-01T00:00:00.000Z")

type FreshnessState = { hasRequest: boolean; hasGoalRevision: boolean }

function makeTransaction(
  status: "pending" | "consumed" = "pending",
  freshness: FreshnessState = { hasRequest: true, hasGoalRevision: false },
  sessionPresent = true,
  turnStatus = "in_progress",
) {
  const row = {
    id: "approval_1",
    sessionId: "session_1",
    taskId: "task_1",
    userId: "user_1",
    turnId: "turn_1",
    toolCallId: "call_1",
    jobId: "job_1",
    type: "submit_application",
    status,
    scopeHash: "scope_hash",
    revision: 3,
    expiresAt: new Date("2026-09-01T01:00:00.000Z"),
    decidedAt: null,
    payload: { applicationTaskId: "task_1", jobId: "job_1" },
  }
  let queryCount = 0
  const tx = {
    $queryRaw: vi.fn(async () => {
      queryCount += 1
      if (queryCount === 1) return sessionPresent ? [{ id: row.sessionId }] : []
      return [freshness]
    }),
    agentApproval: {
      findFirst: vi.fn(async () => ({ ...row })),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { Object.assign(row, data); return { count: 1 } }),
    },
    agentTurn: { findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => where.id === "source_turn_1"
      ? { id: "source_turn_1", userId: "user_1", sessionId: "session_1", status: "completed", source: "user", rootTaskId: "root_1", input: { selectedJobPreparation: { jobId: "job_1" } } }
      : { id: row.turnId, userId: row.userId, sessionId: row.sessionId, source: "user", status: turnStatus, revision: row.revision + 1 }) },
    agentItem: { findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => where.id === waitItemId("approval", row.id)
      ? { id: where.id, revision: 0, content: { waitKind: "approval", approvalId: row.id, toolCallId: row.toolCallId,
        action: "review_application", scopeHash: row.scopeHash, receiptRevision: row.revision,
        expiresAt: row.expiresAt.toISOString(), decision: null } }
      : null) },
    applicationTask: { findFirst: vi.fn(async () => ({ id: "task_1", jobId: "job_1" })) },
    applicationTaskEvent: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
    },
  }
  return {
    row, tx: tx as unknown as Prisma.TransactionClient, rawQuery: tx.$queryRaw, turnFindFirst: tx.agentTurn.findFirst,
    approvalUpdate: tx.agentApproval.updateMany, applicationEventCreate: tx.applicationTaskEvent.create,
  }
}

const input = {
  id: "approval_1",
  userId: "user_1",
  sessionId: "session_1",
  decision: "approved" as const,
  now: NOW,
}

describe("Web pending approval freshness", () => {
  it("rejects a pending approval after a goal revision event", async () => {
    const fake = makeTransaction("pending", { hasRequest: true, hasGoalRevision: true })

    await expect(resolvePendingApprovalInTransaction(fake.tx, input)).rejects.toMatchObject({ code: "approval_revision_mismatch" })
    expect(fake.tx.agentApproval.updateMany).not.toHaveBeenCalled()
    expect(fake.tx.$queryRaw).toHaveBeenCalledTimes(2)
    const rawCalls = fake.rawQuery.mock.calls as unknown as Array<[unknown]>
    const revisionQuery = rawCalls[1]?.[0] as { strings?: readonly string[] } | undefined
    expect(revisionQuery?.strings?.join(" ")).toContain("'goal.revision'")
    expect(revisionQuery?.strings?.join(" ")).not.toContain('revision."type" IN')
  })

  it("fails closed when the durable approval request event is missing", async () => {
    const fake = makeTransaction("pending", { hasRequest: false, hasGoalRevision: false })

    await expect(resolvePendingApprovalInTransaction(fake.tx, input)).rejects.toMatchObject({ code: "approval_integrity_error" })
    expect(fake.tx.agentApproval.updateMany).not.toHaveBeenCalled()
  })

  it("rejects a terminal Turn after locking its session", async () => {
    const fake = makeTransaction("pending", undefined, true, "interrupted")

    await expect(resolvePendingApprovalInTransaction(fake.tx, input)).rejects.toMatchObject({
      code: "approval_scope_mismatch",
      message: "Approval turn is no longer active",
    })
    expect(fake.rawQuery.mock.invocationCallOrder[0]).toBeLessThan(fake.turnFindFirst.mock.invocationCallOrder[0])
    expect(fake.tx.$queryRaw).toHaveBeenCalledOnce()
    expect(fake.tx.agentApproval.updateMany).not.toHaveBeenCalled()
  })

  it("resolves a fresh pending approval after locking its session", async () => {
    const fake = makeTransaction()

    await expect(resolvePendingApprovalInTransaction(fake.tx, input)).resolves.toMatchObject({ id: input.id, status: "pending" })
    expect(fake.tx.agentApproval.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: input.id, status: "pending", revision: 3 }),
      data: { status: "approved", decidedAt: NOW },
    })
    expect(fake.tx.$queryRaw).toHaveBeenCalledTimes(2)
  })

  it("writes reviewed-source binding after the successful approval CAS in the same transaction", async () => {
    const fake = makeTransaction("pending", { hasRequest: true, hasGoalRevision: false }, true, "waiting_for_approval")
    Object.assign(fake.row, {
      type: "review_application", jobId: "job_1", payload: { applicationTaskId: "task_1", jobId: "job_1" },
    })
    await resolvePendingApprovalInTransaction(fake.tx, { ...input, reviewedSourceTurnId: "source_turn_1" })
    expect(fake.row.status).toBe("approved")
    expect(fake.applicationEventCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ taskId: "task_1", type: "reviewed_material_source_bound", actor: "user" }),
    }))
    expect(fake.approvalUpdate.mock.invocationCallOrder[0]).toBeLessThan(fake.applicationEventCreate.mock.invocationCallOrder[0])
  })

  it("preserves consumed receipt replay semantics without a freshness read", async () => {
    const fake = makeTransaction("consumed", { hasRequest: true, hasGoalRevision: true })

    await expect(resolvePendingApprovalInTransaction(fake.tx, input)).rejects.toMatchObject({ code: "approval_already_consumed" })
    expect(fake.tx.$queryRaw).not.toHaveBeenCalled()
    expect(fake.tx.agentApproval.updateMany).not.toHaveBeenCalled()
  })

  it("fails closed when the approval session cannot be locked", async () => {
    const fake = makeTransaction("pending", { hasRequest: true, hasGoalRevision: false }, false)

    await expect(resolvePendingApprovalInTransaction(fake.tx, input)).rejects.toMatchObject({ code: "approval_not_found" })
    expect(fake.tx.agentApproval.updateMany).not.toHaveBeenCalled()
  })
})
