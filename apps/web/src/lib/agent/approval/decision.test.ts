import { describe, expect, it, vi } from "vitest"
import type { Prisma } from "@prisma/client"

import { lockReviewedApprovalOwnersInTransaction, resolvePendingApprovalInTransaction, reviewedApplicationDecisionFields } from "./decision"
import { waitItemId } from "../broker/item-ids"

const NOW = new Date("2026-09-01T00:00:00.000Z")

type FreshnessState = { hasRequest: boolean; hasGoalRevision: boolean }

function makeTransaction(
  status: "pending" | "consumed" = "pending",
  freshness: FreshnessState = { hasRequest: true, hasGoalRevision: false },
  sessionPresent = true,
  turnStatus = "in_progress",
  payload: unknown = { jobId: "job_1" },
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
    payload,
    scopeHash: "scope_hash",
    revision: 3,
    expiresAt: new Date("2026-09-01T01:00:00.000Z"),
    decidedAt: null,
  }
  let queryCount = 0
  const applicationEvents: Array<Record<string, unknown>> = []
  const outboxCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => data)
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
    agentTurn: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => where.id === "source_turn_1"
        ? { id: "source_turn_1", userId: "user_1", sessionId: "session_1", status: "completed", source: "user", rootTaskId: "root_1", input: { selectedJobPreparation: { jobId: "job_1" } } }
        : { id: row.turnId, userId: row.userId, sessionId: row.sessionId, source: "user", status: turnStatus, revision: row.revision + 1 }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => [{ id: where.id, userId: row.userId,
        sessionId: row.sessionId, source: "user", executionMode: "canonical_task_graph", status: "waiting_for_approval",
        revision: row.revision + 1, input: {} }]),
    },
    agentItem: { findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => where.id === waitItemId("approval", row.id)
      ? { id: where.id, revision: 0, content: { waitKind: "approval", approvalId: row.id, toolCallId: row.toolCallId,
        action: "review_application", scopeHash: row.scopeHash, receiptRevision: row.revision,
        expiresAt: row.expiresAt.toISOString(), decision: null } }
      : null) },
    applicationTask: { findFirst: vi.fn(async () => ({ id: "task_1", jobId: "job_1" })) },
    applicationTaskEvent: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => applicationEvents.filter(event => {
        if (event.taskId !== where.taskId || event.type !== where.type
          || where.actor !== undefined && event.actor !== where.actor) return false
        const matches = (filter: unknown) => {
          const pathFilter = filter as { path?: unknown; equals?: unknown } | undefined
          const key = Array.isArray(pathFilter?.path) ? pathFilter.path[0] : null
          const data = event.data as Record<string, unknown> | undefined
          return typeof key === "string" && data?.[key] === pathFilter?.equals
        }
        if (Array.isArray(where.OR)) return (where.OR as Array<Record<string, unknown>>).some(arm => matches(arm.data))
        return where.data === undefined || matches(where.data)
      })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { applicationEvents.push(data); return data }),
    },
    agentOutbox: { create: outboxCreate },
  }
  return {
    row, applicationEvents, tx: tx as unknown as Prisma.TransactionClient, rawQuery: tx.$queryRaw, turnFindFirst: tx.agentTurn.findFirst,
    approvalUpdate: tx.agentApproval.updateMany, applicationEventCreate: tx.applicationTaskEvent.create, outboxCreate,
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

    const result = await resolvePendingApprovalInTransaction(fake.tx, input)
    expect(result).toMatchObject({ id: input.id, status: "pending" })
    expect(result).not.toHaveProperty("payload")
    expect(fake.tx.agentApproval.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: input.id, status: "pending", revision: 3 }),
      data: { status: "approved", decidedAt: NOW },
    })
    expect(fake.tx.$queryRaw).toHaveBeenCalledTimes(2)
  })

  it.each([
    { schema: "objective-application-approval-set-member.v1" },
    { schema: "objective-application-approval-set-member.v99" },
    { schema: "objective-application-approval-set-member." },
  ])("blocks grouped approval member payloads before legacy decision effects", async payload => {
    const fake = makeTransaction("pending", undefined, true, "in_progress", payload)

    await expect(resolvePendingApprovalInTransaction(fake.tx, input)).rejects.toMatchObject({ code: "approval_not_approved" })
    expect(fake.tx.agentApproval.updateMany).not.toHaveBeenCalled()
    expect(fake.tx.$queryRaw).not.toHaveBeenCalled()
  })

  it("does not classify a later submit receipt from a prior review on the same application task", async () => {
    const fake = makeTransaction("pending", { hasRequest: true, hasGoalRevision: false }, true, "waiting_for_approval")
    fake.row.turnId = "fill_turn_1"
    fake.applicationEvents.push({ taskId: "task_1", type: "reviewed_application_review_issued",
      data: { approvalId: "reviewed-application-review:review_turn_1", reviewTurnId: "review_turn_1" } })

    const lockedAsReviewed = await lockReviewedApprovalOwnersInTransaction(fake.tx, {
      approvalId: fake.row.id, userId: fake.row.userId, sessionId: fake.row.sessionId, turnId: fake.row.turnId,
    })
    const decisionFields = await reviewedApplicationDecisionFields(fake.tx, { userId: fake.row.userId,
      sessionId: fake.row.sessionId, approvalId: fake.row.id, turnId: fake.row.turnId, decision: "approved", now: NOW,
      receiptNonce: "submit-receipt" })

    expect(lockedAsReviewed).toBe(false)
    expect(decisionFields).toEqual({})
    await expect(resolvePendingApprovalInTransaction(fake.tx, { ...input, id: fake.row.id }))
      .resolves.toMatchObject({ id: fake.row.id, status: "pending" })
  })

  it("fails closed for exact or corrupted review issuance identity instead of treating it as legacy", async () => {
    const bindings = [
      { approvalId: "review-approval", reviewTurnId: "review_turn_1" },
      { approvalId: "review-approval", reviewTurnId: "foreign_turn" },
      { approvalId: "foreign-approval", reviewTurnId: "review_turn_1" },
    ]
    for (const binding of bindings) {
      const fake = makeTransaction("pending", { hasRequest: true, hasGoalRevision: false }, true, "waiting_for_approval")
      Object.assign(fake.row, { id: "review-approval", turnId: "review_turn_1", type: "review_application", toolCallId: "review-call" })
      fake.applicationEvents.push({ taskId: "task_1", type: "reviewed_application_review_issued", data: binding })

      await expect(resolvePendingApprovalInTransaction(fake.tx, { ...input, id: fake.row.id }))
        .rejects.toMatchObject({ code: "approval_scope_mismatch" })
      expect(fake.tx.agentApproval.updateMany).not.toHaveBeenCalled()
    }
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
    expect(fake.outboxCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ topic: "agent.reviewed-fill.dispatch", idempotencyKey: "agent-reviewed-fill:approval_1" }),
    }))
    expect(fake.applicationEventCreate.mock.invocationCallOrder[0]).toBeLessThan(fake.outboxCreate.mock.invocationCallOrder[0])
  })

  it("preserves consumed receipt replay semantics without a freshness read", async () => {
    const fake = makeTransaction("consumed", { hasRequest: true, hasGoalRevision: true })

    await expect(resolvePendingApprovalInTransaction(fake.tx, input)).rejects.toMatchObject({ code: "approval_already_consumed" })
    expect(fake.tx.$queryRaw).not.toHaveBeenCalled()
    expect(fake.tx.agentApproval.updateMany).not.toHaveBeenCalled()
  })

  it("blocks reviewed receipts from direct legacy store decisions", async () => {
    const fake = makeTransaction()
    fake.row.id = "reviewed-application-review:turn_1"
    await expect(resolvePendingApprovalInTransaction(fake.tx, { ...input, id: fake.row.id }))
      .rejects.toMatchObject({ code: "approval_scope_mismatch" })
    expect(fake.tx.agentApproval.updateMany).not.toHaveBeenCalled()
    expect(fake.tx.$queryRaw).toHaveBeenCalledTimes(2)
  })

  it("fails closed when the approval session cannot be locked", async () => {
    const fake = makeTransaction("pending", { hasRequest: true, hasGoalRevision: false }, false)

    await expect(resolvePendingApprovalInTransaction(fake.tx, input)).rejects.toMatchObject({ code: "approval_not_found" })
    expect(fake.tx.agentApproval.updateMany).not.toHaveBeenCalled()
  })
})
