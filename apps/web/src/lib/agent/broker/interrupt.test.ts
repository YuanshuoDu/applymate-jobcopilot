import { describe, expect, it, vi } from "vitest"

import { createApprovalLedgerState, reduceApprovalLedger, selectApprovalLedgerProjection } from "../../../components/agent-workspace/v2/approval-ledger-view"
import { normalizeTimelineEvent } from "../../../components/agent-workspace/v2/timeline-event-normalizer"
import { cancelPendingWaitsInTransaction } from "./interrupt"

type Row = Record<string, any> // Fixture rows intentionally model Prisma JSON records.

function matchesFilter(actual: unknown, expected: unknown): boolean {
  if (expected === undefined) return true
  if (Array.isArray(expected)) return expected.includes(actual)
  if (expected && typeof expected === "object" && "in" in expected) {
    const values = (expected as { in?: unknown[] }).in
    return Boolean(values?.includes(actual))
  }
  if (expected && typeof expected === "object" && "notIn" in expected) {
    const values = (expected as { notIn?: unknown[] }).notIn
    return !values?.includes(actual)
  }
  return actual === expected
}

function matchesApplicationWhere(application: Row, where: Row): boolean {
  const matchesClause = (clause: Row) => Object.entries(clause).every(([key, expected]) =>
    matchesFilter(application[key], expected))
  return (!where.id || matchesFilter(application.id, where.id.in))
    && (!where.userId || application.userId === where.userId)
    && (!where.sessionId || application.sessionId === where.sessionId)
    && (!where.status || matchesFilter(application.status, where.status))
    && (!where.checkpoint || matchesFilter(application.checkpoint, where.checkpoint))
    && (!where.OR || where.OR.some(matchesClause))
}

describe("Agent wait interrupt cleanup", () => {
  it.each(["task_1", null])("marks pending waits interrupted and preserves authorized approval taskId %s", async (taskId) => {
    const item: Row = {
      id: "agent-wait:approval:approval_1", type: "approval_request", revision: 0,
      content: { approvalId: "approval_1", toolCallId: taskId === null ? "call_1" : null, taskId: "forged_task" },
    }
    const approval: Row = {
      id: "approval_1", sessionId: "session_1", userId: "user_1", turnId: "turn_1", taskId,
      type: "review_application", status: "pending", scopeHash: "scope_1", revision: 1,
    }
    const events: Row[] = []
    const outbox: Row[] = []
    const tx = {
      agentItem: {
        findMany: vi.fn(async () => [item]),
        updateMany: vi.fn(async ({ data }: { data: Row }) => { item.status = data.status; item.content = data.content; return { count: 1 } }),
      },
      agentApproval: {
        findMany: vi.fn(async ({ where }: { where: Row }) => {
          if (where.id?.in) return [approval]
          if (where.type?.in?.includes(approval.type) && matchesFilter(approval.status, where.status)) return [approval]
          return []
        }),
        updateMany: vi.fn(async ({ data }: { data: Row }) => { Object.assign(approval, data); return { count: 1 } }),
      },
      applicationTask: { findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 0 })) },
      agentRunQuestion: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      agentEvent: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: Row }) => { events.push(data); return { ...data, sequence: data.sequence } }),
      },
      agentOutbox: { create: vi.fn(async ({ data }: { data: Row }) => { outbox.push(data); return data }) },
      $queryRaw: vi.fn(async () => [{ eventSequence: BigInt(2) }]),
    }

    await cancelPendingWaitsInTransaction(tx as never, { sessionId: "session_1", userId: "user_1", turnId: "turn_1", clientMessageId: "interrupt_1" })

    expect(item.status).toBe("interrupted")
    expect(item.content).toMatchObject({ cancelled: true, cancellationReason: "interrupt" })
    expect(tx.agentApproval.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: "pending" }), data: expect.objectContaining({ status: "rejected" }) }))
    expect(events[0].payload).toMatchObject({ outcome: "cancelled", reason: "interrupt" })
    expect(events[0].payload.toolCallId).toBe(taskId === null ? "call_1" : null)
    expect(events[0]).toMatchObject({ type: "approval.resolved", sessionId: "session_1", turnId: "turn_1", taskId, correlationId: "approval_1" })
    expect(events[0].payload).toMatchObject({ waitKind: "approval", waitId: "approval_1", itemId: item.id, turnId: "turn_1", outcome: "cancelled", reason: "interrupt" })
    expect(tx.agentApproval.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ sessionId: "session_1", userId: "user_1", turnId: "turn_1", status: "pending" }),
    }))
    expect(outbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ topic: "agent.session.event", payload: expect.objectContaining({ type: "approval.resolved", taskId }) }),
    ]))

    const requested = normalizeTimelineEvent({
      schemaVersion: "agent-harness.v2", id: "requested_approval_1", sessionId: "session_1", turnId: "turn_1", itemId: null, taskId,
      type: "approval.requested", actor: "orchestrator", sequence: "1", correlationId: "approval_1", causationId: null,
      idempotencyKey: "approval:approval_1:requested", payload: { approvalId: "approval_1", action: "review_application", scopeHash: `sha256:${"a".repeat(64)}`, revision: 1 },
    })
    const dispatched = outbox[0].payload as Row
    expect(dispatched).toMatchObject({
      eventId: events[0].id,
      sessionId: events[0].sessionId,
      turnId: events[0].turnId,
      itemId: events[0].itemId,
      taskId: events[0].taskId,
      type: events[0].type,
      actor: events[0].actor,
      correlationId: events[0].correlationId,
      causationId: events[0].causationId,
      payload: events[0].payload,
    })
    const resolved = normalizeTimelineEvent({
      schemaVersion: "agent-harness.v2",
      id: dispatched.eventId,
      sessionId: dispatched.sessionId,
      turnId: dispatched.turnId,
      itemId: dispatched.itemId,
      taskId: dispatched.taskId,
      type: dispatched.type,
      actor: dispatched.actor,
      sequence: dispatched.sequence,
      correlationId: dispatched.correlationId,
      causationId: dispatched.causationId,
      idempotencyKey: dispatched.idempotencyKey,
      payload: dispatched.payload,
    })
    expect(requested).not.toBeNull()
    expect(resolved).not.toBeNull()
    if (!requested || !resolved) throw new Error("Persisted approval events must satisfy the ledger parser")
    let ledger = reduceApprovalLedger(createApprovalLedgerState("session_1"), requested)
    expect(selectApprovalLedgerProjection(ledger).pendingCount).toBe(1)
    ledger = reduceApprovalLedger(ledger, resolved)
    expect(selectApprovalLedgerProjection(ledger)).toMatchObject({ pendingCount: 0, pendingActions: [], approvals: [{ status: "cancelled" }] })
  })

  it("interrupts a projected approval item without inventing a resolution when its scoped pending receipt is missing", async () => {
    const item: Row = {
      id: "agent-wait:approval:approval_missing", type: "approval_request", revision: 3, status: "started",
      content: { approvalId: "approval_missing", taskId: "forged_task" },
    }
    const events: Row[] = []
    const outbox: Row[] = []
    const receiptUpdate = vi.fn(async () => ({ count: 0 }))
    const tx = {
      agentItem: {
        findMany: vi.fn(async () => [item]),
        updateMany: vi.fn(async ({ data }: { data: Row }) => { Object.assign(item, data); return { count: 1 } }),
      },
      agentApproval: { findMany: vi.fn(async () => []), updateMany: receiptUpdate },
      applicationTask: { findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 0 })) },
      agentRunQuestion: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      agentEvent: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: Row }) => { events.push(data); return { ...data, sequence: data.sequence } }),
      },
      agentOutbox: { create: vi.fn(async ({ data }: { data: Row }) => { outbox.push(data); return data }) },
      $queryRaw: vi.fn(async () => [{ eventSequence: BigInt(1) }]),
    }

    await cancelPendingWaitsInTransaction(tx as never, { sessionId: "session_1", userId: "user_1", turnId: "turn_1", clientMessageId: "interrupt_missing_receipt" })

    expect(item).toMatchObject({ status: "interrupted", content: { cancelled: true, cancellationReason: "interrupt" } })
    expect(receiptUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "approval_missing" }) }))
    expect(events).toEqual([])
    expect(outbox).toEqual([])
  })

  it("keeps question cancellation on its existing builder-to-normalizer contract", async () => {
    const sessionId = "70463535-1444-4bba-ae3b-b80578d2dd0b"
    const turnId = "70463535-1444-4bba-ae3b-b80578d2dd0c"
    const questionId = "70463535-1444-4bba-ae3b-b80578d2dd0a"
    const item: Row = {
      id: `agent-wait:question:${questionId}`, type: "question", revision: 0, status: "started",
      content: { questionId, toolCallId: null, question: "PRIVATE_QUESTION_BODY", options: ["PRIVATE_OPTION_LABEL"], answer: "PRIVATE_ANSWER" },
    }
    const outbox: Row[] = []
    const tx = {
      agentItem: {
        findMany: vi.fn(async () => [item]),
        updateMany: vi.fn(async ({ data }: { data: Row }) => { Object.assign(item, data); return { count: 1 } }),
      },
      agentApproval: {
        findMany: vi.fn(async () => []),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      applicationTask: { findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 0 })) },
      agentRunQuestion: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      agentEvent: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: Row }) => data),
      },
      agentOutbox: { create: vi.fn(async ({ data }: { data: Row }) => { outbox.push(data); return data }) },
      $queryRaw: vi.fn(async () => [{ eventSequence: BigInt(1) }]),
    }

    await cancelPendingWaitsInTransaction(tx as never, {
      sessionId, userId: "user_1", turnId, clientMessageId: "70463535-1444-4bba-ae3b-b80578d2dd0e",
    })

    expect(outbox).toHaveLength(1)
    const dispatched = outbox[0]!.payload as Row
    expect(dispatched).toMatchObject({ type: "question.cancelled", taskId: null })
    expect(dispatched.payload).toEqual({
      waitKind: "question", waitId: questionId, itemId: item.id, toolCallId: null, outcome: "cancelled", reason: "interrupt",
    })
    expect(dispatched.payload).not.toHaveProperty("turnId")
    expect(JSON.stringify(dispatched)).not.toMatch(/PRIVATE_QUESTION_BODY|PRIVATE_OPTION_LABEL|PRIVATE_ANSWER/)

    const normalized = normalizeTimelineEvent({
      schemaVersion: "agent-harness.v2",
      id: dispatched.eventId,
      sessionId: dispatched.sessionId,
      turnId: dispatched.turnId,
      itemId: dispatched.itemId,
      taskId: dispatched.taskId,
      type: dispatched.type,
      actor: dispatched.actor,
      sequence: dispatched.sequence,
      correlationId: dispatched.correlationId,
      causationId: dispatched.causationId,
      idempotencyKey: dispatched.idempotencyKey,
      payload: dispatched.payload,
    })
    expect(normalized).toMatchObject({ type: "question.cancelled", taskId: null, payload: dispatched.payload })
  })

  it("cancels an unprojected review receipt and its exact material-ready task after Stop", async () => {
    const receipt: Row = {
      id: "approval_2", sessionId: "session_1", userId: "user_1", turnId: "turn_1", taskId: "task_2",
      type: "review_application", status: "pending", scopeHash: "scope_2", revision: 4,
      payload: { applicationTaskId: "application_2" },
    }
    const approvedReceipt: Row = {
      id: "approval_3", sessionId: "session_1", userId: "user_1", turnId: "turn_1", taskId: "task_3",
      type: "review_application", status: "approved", scopeHash: "scope_3", revision: 5,
      payload: { applicationTaskId: "application_3" },
    }
    const submitReceipt: Row = {
      id: "approval_submit", sessionId: "session_1", userId: "user_1", turnId: "turn_1", taskId: "task_submit",
      type: "submit_application", status: "approved", payload: { applicationTaskId: "application_submit" },
    }
    const receipts = [receipt, approvedReceipt, submitReceipt]
    const applications = [
      { id: "application_2", userId: "user_1", sessionId: "session_1", status: "waiting_for_user", checkpoint: "materials_ready" },
      { id: "application_3", userId: "user_1", sessionId: "session_1", status: "waiting_for_user", checkpoint: "materials_ready" },
    ]
    const agentApprovalUpdate = vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      let count = 0
      for (const row of receipts) {
        if ((where.id && row.id !== where.id) || !matchesFilter(row.type, where.type)
          || (where.turnId && row.turnId !== where.turnId) || !matchesFilter(row.status, where.status)) continue
        Object.assign(row, data)
        count += 1
      }
      return { count }
    })
    const tx = {
      agentItem: { findMany: vi.fn(async () => []), updateMany: vi.fn() },
      agentRunQuestion: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      agentApproval: {
        findMany: vi.fn(async ({ where }: { where: Row }) => receipts.filter(row =>
          matchesFilter(row.type, where.type) && matchesFilter(row.turnId, where.turnId) && matchesFilter(row.status, where.status))),
        updateMany: agentApprovalUpdate,
      },
      applicationTask: {
        findMany: vi.fn(async ({ where }: { where: Row }) => applications.filter(application => matchesApplicationWhere(application, where))),
        updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
          let count = 0
          for (const application of applications) {
            if (matchesApplicationWhere(application, where)) {
              Object.assign(application, data)
              count += 1
            }
          }
          return { count }
        }),
      },
      agentEvent: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: Row }) => ({ ...data, sequence: BigInt(3) })),
      },
      agentOutbox: { create: vi.fn(async ({ data }: { data: Row }) => data) },
      $queryRaw: vi.fn(async () => [{ eventSequence: BigInt(2) }]),
    }

    await cancelPendingWaitsInTransaction(tx as never, { sessionId: "session_1", userId: "user_1", turnId: "turn_1", clientMessageId: "stop_2" })

    expect(applications).toEqual([
      expect.objectContaining({ status: "cancelled", checkpoint: "turn_stopped_before_submit" }),
      expect.objectContaining({ status: "cancelled", checkpoint: "turn_stopped_before_submit" }),
    ])
    expect(agentApprovalUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { sessionId: "session_1", userId: "user_1", turnId: "turn_1", type: "review_application", status: { in: ["pending", "approved"] } },
      data: expect.objectContaining({ status: "rejected" }),
    }))
    expect(receipt.status).toBe("rejected")
    expect(approvedReceipt.status).toBe("rejected")
    expect(submitReceipt.status).toBe("approved")
    expect(tx.agentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: "approval.resolved", turnId: "turn_1", correlationId: "approval_2" }),
    }))
  })

  it("captures projected review payload before rejecting its receipt", async () => {
    const receipt: Row = {
      id: "approval_projected", sessionId: "session_1", userId: "user_1", turnId: "turn_1", taskId: "task_4",
      type: "review_application", status: "pending", scopeHash: "scope_4", revision: 6,
      payload: { applicationTaskId: "application_4" },
    }
    const item: Row = {
      id: "review_item", type: "approval_request", revision: 2, status: "started",
      content: { approvalId: "approval_projected" },
    }
    const application = { id: "application_4", userId: "user_1", sessionId: "session_1", status: "waiting_for_user", checkpoint: "materials_ready" }
    const tx = {
      agentItem: {
        findMany: vi.fn(async () => [item]),
        updateMany: vi.fn(async ({ data }: { data: Row }) => { Object.assign(item, data); return { count: 1 } }),
      },
      agentRunQuestion: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      agentApproval: {
        findMany: vi.fn(async ({ where }: { where: Row }) => matchesFilter(receipt.type, where.type)
          && matchesFilter(receipt.status, where.status) ? [receipt] : []),
        updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
          if (where.id === receipt.id && receipt.status === "pending") Object.assign(receipt, data)
          if (where.type === "review_application" && ["pending", "approved"].includes(receipt.status)) Object.assign(receipt, data)
          return { count: 1 }
        }),
      },
      applicationTask: {
        findMany: vi.fn(async ({ where }: { where: Row }) => [application].filter(row => matchesApplicationWhere(row, where))),
        updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
          if (matchesApplicationWhere(application, where)) {
            Object.assign(application, data)
            return { count: 1 }
          }
          return { count: 0 }
        }),
      },
      agentEvent: { findFirst: vi.fn(async () => null), create: vi.fn(async ({ data }: { data: Row }) => ({ ...data, sequence: BigInt(3) })) },
      agentOutbox: { create: vi.fn(async () => ({ id: "outbox_4" })) },
      $queryRaw: vi.fn(async () => [{ eventSequence: BigInt(2) }]),
    }

    await cancelPendingWaitsInTransaction(tx as never, { sessionId: "session_1", userId: "user_1", turnId: "turn_1", clientMessageId: "stop_4" })

    expect(item.status).toBe("interrupted")
    expect(receipt.status).toBe("rejected")
    expect(application).toMatchObject({ status: "cancelled", checkpoint: "turn_stopped_before_submit" })
  })

  it("stops only linked pre-submit review and queue tasks while preserving submitted or uncertain work", async () => {
    const receiptScope = { sessionId: "session_1", userId: "user_1" }
    const receipts: Row[] = [
      { ...receiptScope, id: "review_active", type: "review_application", status: "approved", turnId: "turn_1", payload: { applicationTaskId: "review_active_task" } },
      { ...receiptScope, id: "review_queued", type: "review_application", status: "pending", turnId: "turn_1", payload: { applicationTaskId: "review_queued_task" } },
      { ...receiptScope, id: "review_filled", type: "review_application", status: "approved", turnId: "turn_1", payload: { applicationTaskId: "review_filled_task" } },
      { ...receiptScope, id: "review_answer", type: "review_application", status: "approved", turnId: "turn_1", payload: { applicationTaskId: "review_answer_task" } },
      { ...receiptScope, id: "review_takeover", type: "review_application", status: "approved", turnId: "turn_1", payload: { applicationTaskId: "review_takeover_task" } },
      { ...receiptScope, id: "submit_waiting", type: "submit_application", status: "pending", turnId: "turn_1", payload: { applicationTaskId: "submit_waiting_task" } },
      { ...receiptScope, id: "submit_retry", type: "submit_application", status: "approved", turnId: "turn_1", payload: { applicationTaskId: "submit_retry_task" } },
      { ...receiptScope, id: "submit_started", type: "submit_application", status: "approved", turnId: "turn_1", payload: { applicationTaskId: "submit_started_task" } },
      { ...receiptScope, id: "submit_uncertain", type: "submit_application", status: "consumed", turnId: "turn_1", payload: { applicationTaskId: "submit_uncertain_task" } },
      { ...receiptScope, id: "submit_submitted", type: "submit_application", status: "consumed", turnId: "turn_1", payload: { applicationTaskId: "submit_submitted_task" } },
      { ...receiptScope, id: "submit_admin_review", type: "submit_application", status: "consumed", turnId: "turn_1", payload: { applicationTaskId: "submit_admin_review_task" } },
      { ...receiptScope, id: "other_turn", type: "review_application", status: "approved", turnId: "turn_2", payload: { applicationTaskId: "other_turn_task" } },
    ]
    const applications: Row[] = [
      { id: "review_active_task", userId: "user_1", sessionId: "session_1", status: "filling", checkpoint: "browser_active" },
      { id: "review_queued_task", userId: "user_1", sessionId: "session_1", status: "filling", checkpoint: "form_fill_queued" },
      { id: "review_filled_task", userId: "user_1", sessionId: "session_1", status: "waiting_for_authorization", checkpoint: "form_filled" },
      { id: "review_answer_task", userId: "user_1", sessionId: "session_1", status: "waiting_for_user", checkpoint: "form_answer_required" },
      { id: "review_takeover_task", userId: "user_1", sessionId: "session_1", status: "waiting_for_user", checkpoint: "user_takeover" },
      { id: "submit_waiting_task", userId: "user_1", sessionId: "session_1", status: "waiting_for_authorization", checkpoint: "form_filled" },
      { id: "submit_retry_task", userId: "user_1", sessionId: "session_1", status: "waiting_for_authorization", checkpoint: "queue_retry" },
      { id: "submit_started_task", userId: "user_1", sessionId: "session_1", status: "filling", checkpoint: "submission_request_started" },
      { id: "submit_uncertain_task", userId: "user_1", sessionId: "session_1", status: "waiting_for_user", checkpoint: "submission_uncertain" },
      { id: "submit_submitted_task", userId: "user_1", sessionId: "session_1", status: "submitted", checkpoint: "submitted" },
      { id: "submit_admin_review_task", userId: "user_1", sessionId: "session_1", status: "waiting_for_user", checkpoint: "admin_review" },
      { id: "other_turn_task", userId: "user_1", sessionId: "session_1", status: "filling", checkpoint: "browser_active" },
    ]
    const outboxCreate = vi.fn(async () => ({ id: "outbox_stop" }))
    const tx = {
      agentItem: { findMany: vi.fn(async () => []), updateMany: vi.fn() },
      agentRunQuestion: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      agentApproval: {
        findMany: vi.fn(async ({ where }: { where: Row }) => receipts.filter(receipt =>
          (!where.sessionId || receipt.sessionId === where.sessionId)
          && (!where.userId || receipt.userId === where.userId)
          && matchesFilter(receipt.turnId, where.turnId)
          && matchesFilter(receipt.type, where.type)
          && matchesFilter(receipt.status, where.status))),
        updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
          let count = 0
          for (const receipt of receipts) {
            if (!matchesFilter(receipt.id, where.id) || !matchesFilter(receipt.type, where.type)
              || !matchesFilter(receipt.turnId, where.turnId) || !matchesFilter(receipt.status, where.status)) continue
            Object.assign(receipt, data)
            count += 1
          }
          return { count }
        }),
      },
      applicationTask: { findMany: vi.fn(async ({ where }: { where: Row }) => applications.filter(application => matchesApplicationWhere(application, where))), updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        let count = 0
        for (const application of applications) {
          if (matchesApplicationWhere(application, where)) { Object.assign(application, data); count += 1 }
        }
        return { count }
      }) },
      agentEvent: { findFirst: vi.fn(async () => null), create: vi.fn(async ({ data }: { data: Row }) => ({ ...data, sequence: BigInt(4) })) },
      agentOutbox: { create: outboxCreate },
      $queryRaw: vi.fn(async () => [{ eventSequence: BigInt(3) }]),
    }

    await cancelPendingWaitsInTransaction(tx as never, { sessionId: "session_1", userId: "user_1", turnId: "turn_1", clientMessageId: "stop_liveness" })

    const workerCanClaim = (task: Row) => task.status === "filling"
      && !["submission_request_started", "submission_uncertain"].includes(task.checkpoint)
    for (const id of ["review_active_task", "review_queued_task", "review_filled_task", "review_answer_task", "review_takeover_task", "submit_waiting_task", "submit_retry_task"]) {
      const task = applications.find(row => row.id === id)!
      expect(task).toMatchObject({ status: "cancelled", checkpoint: "turn_stopped_before_submit" })
      expect(workerCanClaim(task)).toBe(false)
    }
    expect(applications.find(row => row.id === "submit_started_task")).toMatchObject({ status: "filling", checkpoint: "submission_request_started" })
    expect(applications.find(row => row.id === "submit_uncertain_task")).toMatchObject({ status: "waiting_for_user", checkpoint: "submission_uncertain" })
    expect(applications.find(row => row.id === "submit_submitted_task")).toMatchObject({ status: "submitted", checkpoint: "submitted" })
    expect(applications.find(row => row.id === "submit_admin_review_task")).toMatchObject({ status: "waiting_for_user", checkpoint: "admin_review" })
    expect(applications.find(row => row.id === "other_turn_task")).toMatchObject({ status: "filling", checkpoint: "browser_active" })
    expect(workerCanClaim(applications.find(row => row.id === "submit_started_task")!)).toBe(false)
    expect(workerCanClaim(applications.find(row => row.id === "submit_uncertain_task")!)).toBe(false)
    expect(receipts.find(row => row.id === "submit_waiting")?.status).toBe("rejected")
    expect(receipts.find(row => row.id === "submit_retry")?.status).toBe("rejected")
    expect(receipts.find(row => row.id === "submit_started")?.status).toBe("approved")
    expect(receipts.find(row => row.id === "submit_uncertain")?.status).toBe("consumed")
    expect(receipts.find(row => row.id === "submit_submitted")?.status).toBe("consumed")
    expect((tx.agentRunQuestion.deleteMany as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({
      where: { userId: "user_1", runId: "session_1", answer: null, id: { startsWith: "agent-question:turn_1:" } },
    })
    expect(tx.agentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: "approval.resolved", correlationId: "submit_waiting", payload: expect.objectContaining({ action: "submit_application", outcome: "cancelled" }) }),
    }))
    expect(outboxCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ topic: "agent.session.event", payload: expect.objectContaining({ type: "approval.resolved", correlationId: "submit_waiting" }) }),
    }))
  })
})
