import { describe, expect, it, vi } from "vitest"
import type { Prisma } from "@prisma/client"

import { resolvePendingApprovalInTransaction } from "./decision"
import { validateReviewedFillHandoff, assertReviewedFillDecisionWait, ReviewedFillHandoffDeferredError } from "./reviewed-fill-handoff"
import { REVIEWED_FILL_SOURCE_EVENT, REVIEWED_FILL_SOURCE_SCHEMA } from "./reviewed-fill-source-binding"
import { waitItemId } from "../broker/item-ids"

const NOW = new Date("2026-11-20T12:00:00.000Z")

function handoffHarness(options: { scheduled?: boolean; status?: string; expiresAt?: Date; event?: boolean } = {}) {
  const approval = {
    id: "approval_1", userId: "user_1", sessionId: "session_1", turnId: "gate_turn_1", taskId: "application_1",
    jobId: "job_1", toolCallId: "call_1", type: "review_application", status: options.status ?? "pending",
    scopeHash: "scope_hash_1", revision: 3, expiresAt: options.expiresAt ?? new Date("2026-11-20T12:10:00.000Z"),
    decidedAt: options.status && options.status !== "pending" ? NOW : null, payload: { applicationTaskId: "application_1", jobId: "job_1",
      ...(options.scheduled ? { scheduledGateReview: { schemaVersion: "scheduled.v1", gateTaskId: "gate_1" } } : {}) },
  }
  const task = {
    id: "application_1", userId: "user_1", sessionId: "session_1", jobId: "job_1",
    status: "waiting_for_user", checkpoint: "materials_ready", fillTurnId: null,
    fillTurnSessionId: null, fillTurnUserId: null,
  }
  const approvalTurn = { id: "gate_turn_1", userId: "user_1", sessionId: "session_1", source: "user",
    status: "waiting_for_approval", revision: 4, rootTaskId: "root_1" }
  const sourceTurn = { id: "source_turn_1", userId: "user_1", sessionId: "session_1", source: "user",
    status: "completed", rootTaskId: "source_root_1", input: { selectedJobPreparation: { jobId: "job_1" } } }
  const fillTurn = { id: "fill_turn_1", userId: "user_1", sessionId: "session_1", source: "user", status: "in_progress", input: {
    clientMessageId: "agent-reviewed-fill:approval_1",
    reviewedApplicationMaterialSource: { schemaVersion: REVIEWED_FILL_SOURCE_SCHEMA, sourceTurnId: sourceTurn.id },
  } }
  const waitContent: Record<string, unknown> = {
    waitKind: "approval", approvalId: approval.id, toolCallId: approval.toolCallId,
    action: "review_application", scopeHash: approval.scopeHash, receiptRevision: approval.revision,
    expiresAt: approval.expiresAt.toISOString(), decision: null,
  }
  const waitItem = { id: waitItemId("approval", approval.id), sessionId: "session_1", turnId: approvalTurn.id,
    type: "approval_request", status: "started", revision: 0, content: waitContent }
  const events: Array<Record<string, unknown>> = options.event ? [{ id: "event_1", taskId: task.id,
    type: REVIEWED_FILL_SOURCE_EVENT, actor: "user",
    data: { schemaVersion: REVIEWED_FILL_SOURCE_SCHEMA, approvalId: approval.id, sourceTurnId: sourceTurn.id } }] : []
  let rawReads = 0
  const tx = {
    $queryRaw: vi.fn(async () => (++rawReads === 1 ? [{ id: "session_1" }] : [{ hasRequest: true, hasGoalRevision: false }])),
    agentApproval: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const status = where.status
        const statusMatches = status === undefined || status === approval.status
          || Boolean(status && typeof status === "object" && "in" in status
            && Array.isArray((status as { in: unknown }).in) && ((status as { in: string[] }).in).includes(approval.status))
        if (where.id !== approval.id || where.userId !== approval.userId || where.sessionId !== approval.sessionId
          || !statusMatches || (where.type && where.type !== approval.type)) return null
        return approval
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (where.id !== approval.id || where.status !== approval.status) return { count: 0 }
        Object.assign(approval, data); return { count: 1 }
      }),
    },
    applicationTask: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.id !== task.id || where.userId !== task.userId || where.sessionId !== task.sessionId
          || where.jobId !== task.jobId || (where.status && where.status !== task.status)
          || (where.checkpoint && where.checkpoint !== task.checkpoint)) return null
        return task
      }),
    },
    applicationTaskEvent: {
      findMany: vi.fn(async () => events.slice(0, 2)),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { events.push({ ...data, id: `event_${events.length + 1}` }); return data }),
    },
    agentTurn: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = where.id === sourceTurn.id ? sourceTurn : where.id === approvalTurn.id ? approvalTurn
          : where.id === fillTurn.id ? fillTurn : null
        if (!row || row.userId !== where.userId || row.sessionId !== where.sessionId
          || (where.status && row.status !== where.status) || (where.source && row.source !== where.source)) return null
        return row
      }),
      findMany: vi.fn(async () => []),
    },
    agentItem: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => where.id === waitItem.id
        && where.sessionId === waitItem.sessionId && where.turnId === waitItem.turnId
        && where.type === waitItem.type && where.status === waitItem.status ? waitItem : null),
    },
    agentOutbox: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data) },
  }
  return {
    tx: tx as unknown as Prisma.TransactionClient, approval, task, approvalTurn, sourceTurn, fillTurn, waitItem, events,
    async accept() {
      await resolvePendingApprovalInTransaction(tx as unknown as Prisma.TransactionClient, {
        id: approval.id, userId: approval.userId, sessionId: approval.sessionId, decision: "approved", now: NOW,
        reviewedSourceTurnId: sourceTurn.id,
      })
    },
    completePredecessor() {
      approvalTurn.status = "completed"
      approvalTurn.revision = 5
      waitItem.status = "completed"
      waitItem.revision = 1
      waitItem.content = { ...waitItem.content, decision: "approved", responseAvailable: true, respondedAt: NOW.toISOString() }
    },
  }
}

const command = { approvalId: "approval_1", userId: "user_1", sessionId: "session_1", applicationTaskId: "application_1",
  sourceTurnId: "source_turn_1", clientMessageId: "agent-reviewed-fill:approval_1", now: NOW }

describe("reviewed fill handoff", () => {
  it("records only the exact manual canonical wait, then admits after its predecessor completes", async () => {
    const fake = handoffHarness()
    await fake.accept()
    expect(fake.events).toHaveLength(1)
    await expect(validateReviewedFillHandoff(fake.tx, command)).rejects.toMatchObject({ code: "reviewed_fill_source_unavailable" })
    fake.completePredecessor()
    await expect(validateReviewedFillHandoff(fake.tx, command)).resolves.toEqual({ sourceTurnId: "source_turn_1" })
  })

  it("replays an exact started fill from its private approval binding when dispatch has only the outbox id", async () => {
    const fake = handoffHarness({ status: "approved", event: true })
    fake.completePredecessor()
    Object.assign(fake.task, { status: "filling", checkpoint: "taskgraph_fill_queued", fillTurnId: fake.fillTurn.id,
      fillTurnSessionId: "session_1", fillTurnUserId: "user_1" })
    const replay = { approvalId: "approval_1", userId: "user_1", sessionId: "session_1",
      applicationTaskId: "application_1", clientMessageId: "agent-reviewed-fill:approval_1", now: NOW }
    await expect(validateReviewedFillHandoff(fake.tx, replay)).resolves.toEqual({ sourceTurnId: "source_turn_1" })
    await expect(validateReviewedFillHandoff(fake.tx, { ...replay, approvalId: "other_approval" }))
      .rejects.toMatchObject({ code: "reviewed_fill_source_unavailable" })
  })

  it("rejects a forged command selector without the accepted source event", async () => {
    const fake = handoffHarness({ status: "approved" })
    fake.completePredecessor()
    await expect(validateReviewedFillHandoff(fake.tx, command)).rejects.toMatchObject({ code: "reviewed_fill_source_unavailable" })
  })

  it("rejects invalid authority and defers active predecessors or competing turns", async () => {
    const scheduled = handoffHarness({ scheduled: true })
    await expect(assertReviewedFillDecisionWait(scheduled.tx, { approvalId: "approval_1", userId: "user_1", sessionId: "session_1", decision: "approved", now: NOW }))
      .rejects.toMatchObject({ code: "reviewed_fill_source_unavailable" })
    expect(scheduled.tx.agentApproval.updateMany).not.toHaveBeenCalled()
    for (const fake of [
      handoffHarness({ status: "approved", expiresAt: new Date("2026-11-20T11:00:00.000Z"), event: true }),
      handoffHarness({ status: "consumed", event: true }),
    ]) {
      fake.completePredecessor()
      await expect(validateReviewedFillHandoff(fake.tx, command)).rejects.toMatchObject({ code: "reviewed_fill_source_unavailable" })
    }
    const stopped = handoffHarness({ status: "approved", event: true })
    stopped.completePredecessor()
    stopped.approvalTurn.status = "interrupted"
    await expect(validateReviewedFillHandoff(stopped.tx, command)).rejects.toMatchObject({ code: "reviewed_fill_source_unavailable" })
    const predecessorActive = handoffHarness({ status: "approved", event: true })
    predecessorActive.completePredecessor()
    predecessorActive.approvalTurn.status = "in_progress"
    await expect(validateReviewedFillHandoff(predecessorActive.tx, command)).rejects.toBeInstanceOf(ReviewedFillHandoffDeferredError)
    const competing = handoffHarness({ status: "approved", event: true })
    competing.completePredecessor()
    vi.mocked(competing.tx.agentTurn.findMany).mockResolvedValueOnce([{ id: "other_active_turn" }] as never)
    await expect(validateReviewedFillHandoff(competing.tx, command)).rejects.toBeInstanceOf(ReviewedFillHandoffDeferredError)
  })

  it("fails closed when the accepted selector has duplicate private source events", async () => {
    const duplicate = handoffHarness({ status: "approved", event: true })
    duplicate.events.push({ ...duplicate.events[0], id: "event_duplicate" })
    duplicate.completePredecessor()
    await expect(validateReviewedFillHandoff(duplicate.tx, command)).rejects.toMatchObject({ code: "reviewed_fill_source_unavailable" })
  })

  it("requires the completed wait to match the persisted approval decision", async () => {
    const mismatched = handoffHarness({ status: "approved", event: true })
    mismatched.completePredecessor()
    mismatched.waitItem.content = { ...mismatched.waitItem.content, respondedAt: "2026-11-20T12:00:01.000Z" }
    await expect(validateReviewedFillHandoff(mismatched.tx, command)).rejects.toMatchObject({ code: "reviewed_fill_source_unavailable" })

    const wrongRevision = handoffHarness({ status: "approved", event: true })
    wrongRevision.completePredecessor()
    wrongRevision.waitItem.revision = 2
    await expect(validateReviewedFillHandoff(wrongRevision.tx, command)).rejects.toMatchObject({ code: "reviewed_fill_source_unavailable" })
  })
})
