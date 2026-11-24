import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PrismaClient } from "@prisma/client"

import { answerQuestion, createQuestionWait, decideApproval } from "./store"
import { redactSensitiveValue } from "@jobcopilot/shared"
import { projectApprovalLedgerRow } from "@/components/agent-workspace/v2/approval-ledger-parser"
import { createApprovalLedgerState, reduceApprovalLedger, selectApprovalLedgerProjection } from "@/components/agent-workspace/v2/approval-ledger-view"
import { normalizeTimelineEvent } from "@/components/agent-workspace/v2/timeline-event-normalizer"

const reviewedDecisionReader = vi.hoisted(() => vi.fn())
vi.mock("../approval/reviewed-application-review-decision", () => ({ readReviewedApplicationReviewDecision: reviewedDecisionReader }))
vi.mock("../approval/reviewed-fill-handoff", () => ({ assertReviewedFillDecisionWait: vi.fn() }))
vi.mock("../approval/reviewed-fill-source-binding", () => ({ persistReviewedFillSourceInTransaction: vi.fn() }))
vi.mock("../approval/reviewed-fill-handoff-outbox", () => ({ enqueueReviewedFillHandoffInTransaction: vi.fn() }))

beforeEach(() => { reviewedDecisionReader.mockReset(); reviewedDecisionReader.mockResolvedValue({ status: "legacy" }) })

type Row = Record<string, any> // Test fixture rows mirror Prisma JSON records.

function fakeDb(taskId: string | null = null, sessionPresent = true) {
  const turn: Row = { id: "turn_1", status: "in_progress", revision: 4 }
  const item: Row = {
    id: "agent-wait:question:question_1", status: "started", revision: 0,
    content: { waitKind: "question", questionId: "question_1", toolCallId: "call_1", stage: "profile", question: "Work authorisation?", options: [{ value: "yes", label: "Yes" }], answerAvailable: false },
  }
  const approval: Row = {
    id: "approval_1", sessionId: "session_1", userId: "user_1", turnId: "turn_1", taskId, toolCallId: "call_approval",
    jobId: "job_1", type: "submit_application", status: "pending", revision: 4, scopeHash: "scope_hash", expiresAt: new Date("2026-09-02T00:00:00.000Z"),
  }
  const events: Row[] = []
  const outbox: Row[] = []
  const tx = {
    $queryRaw: vi.fn(async (query: unknown) => {
      const sqlQuery = query as { strings?: readonly string[] }
      const strings = sqlQuery.strings ?? (Array.isArray(query) ? query as readonly string[] : [])
      const sql = strings.join(" ")
      if (sql.includes("pg_current_xact_id")) return [{ transaction_id: "123" }]
      if (sql.includes('FROM "agent_sessions"')) return sessionPresent ? [{ id: "session_1" }] : []
      if (sql.includes('FROM "agent_turns"')) return [{ id: "turn_1" }]
      if (sql.includes('FROM "application_tasks"')) return [{ id: "task_approval" }]
      if (sql.includes('FROM "agent_events"')) return [{ hasRequest: true, hasGoalRevision: false }]
      return [{ eventSequence: BigInt(9) }]
    }),
    agentTurn: {
      findFirst: vi.fn(async () => ({ ...turn })),
      updateMany: vi.fn(async ({ where }: { where: Row }) => {
        if (where.revision !== turn.revision || where.id !== turn.id) return { count: 0 }
        turn.revision += 1
        if (where.status !== "waiting_for_user" && where.status !== "waiting_for_approval") turn.status = "waiting_for_user"
        return { count: 1 }
      }),
    },
    agentItem: {
      create: vi.fn(async ({ data }: { data: Row }) => { Object.assign(item, data); return data }),
      findFirst: vi.fn(async () => item),
      updateMany: vi.fn(async ({ data }: { data: Row }) => { Object.assign(item, data); item.status = "completed"; item.revision += 1; return { count: 1 } }),
      findMany: vi.fn(async () => []),
    },
    agentApproval: {
      findFirst: vi.fn(async () => approval),
      updateMany: vi.fn(async ({ data }: { data: Row }) => { Object.assign(approval, data); return { count: 1 } }),
    },
    applicationTaskEvent: { findMany: vi.fn(async () => []) },
    agentEvent: {
      findFirst: vi.fn(async ({ where }: { where: Row }) => events.find((event) => Object.entries(where).every(([key, value]) => event[key] === value)) ?? null),
      create: vi.fn(async ({ data }: { data: Row }) => { const event = { ...data, id: data.id ?? `event_${events.length + 1}`, sequence: BigInt(events.length + 10) }; events.push(event); return event }),
    },
    agentOutbox: { create: vi.fn(async ({ data }: { data: Row }) => { outbox.push(data); return data }) },
  }
  const db = { $transaction: vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => work(tx)) } as unknown as PrismaClient
  return { db, tx, turn, item, approval, events, outbox }
}

describe("Agent wait broker", () => {
  it("projects a question as a durable wait without creating another Turn", async () => {
    const fake = fakeDb()
    const result = await createQuestionWait(fake.db, {
      questionId: "question_1", sessionId: "session_1", userId: "user_1", turnId: "turn_1", toolCallId: "call_1",
      stage: "profile", question: "Work authorisation?", options: [{ value: "yes", label: "Yes" }], expectedTurnRevision: 4,
    })

    expect(result).toEqual({ itemId: "agent-wait:question:question_1", turnRevision: 5 })
    expect(fake.tx.agentTurn.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "waiting_for_user" }) }))
    expect(fake.tx.agentTurn.findFirst).toHaveBeenCalledTimes(1)
  })

  it("answers the original question, wakes the same Turn, and keeps raw answer out of facts", async () => {
    const fake = fakeDb()
    fake.turn.status = "waiting_for_user"
    fake.turn.revision = 5
    const result = await answerQuestion(fake.db, {
      waitId: "question_1", sessionId: "session_1", userId: "user_1", expectedTurnId: "turn_1", expectedRevision: 5,
      clientMessageId: "answer_1", answer: "yes",
    })

    expect(result).toMatchObject({ disposition: "resolved", status: "answered", turnId: "turn_1", toolCallId: "call_1", nextTurnRevision: 6 })
    expect(fake.item.content.answer).toBe("yes")
    expect(JSON.stringify(fake.events.map((event) => event.payload))).not.toContain("yes")
    expect(JSON.stringify(fake.outbox)).not.toContain("yes")
    expect(fake.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "question.answered", taskId: null }),
      expect.objectContaining({ type: "turn.wakeup", taskId: null }),
    ]))
    expect(fake.outbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ topic: "agent.session.event", payload: expect.objectContaining({ type: "question.answered", taskId: null }) }),
      expect.objectContaining({ topic: "agent.turn.wakeup", payload: expect.objectContaining({ type: "turn.wakeup", taskId: null }) }),
    ]))
  })

  it("returns an idempotent duplicate and does not attempt a second answer", async () => {
    const fake = fakeDb()
    fake.turn.status = "waiting_for_user"
    fake.turn.revision = 5
    const first = await answerQuestion(fake.db, {
      waitId: "question_1", sessionId: "session_1", userId: "user_1", expectedTurnId: "turn_1", expectedRevision: 5,
      clientMessageId: "answer_retry", answer: "yes",
    })
    const second = await answerQuestion(fake.db, {
      waitId: "question_1", sessionId: "session_1", userId: "user_1", expectedTurnId: "turn_1", expectedRevision: 5,
      clientMessageId: "answer_retry", answer: "yes",
    })

    expect(first.disposition).toBe("resolved")
    expect(second).toMatchObject({ disposition: "duplicate", sequence: first.sequence, turnId: "turn_1" })
    expect(fake.tx.agentItem.updateMany).toHaveBeenCalledTimes(1)
  })

  it.each([
    { decision: "approved" as const, taskId: "task_approval" },
    { decision: "rejected" as const, taskId: "task_approval" },
    { decision: "approved" as const, taskId: null },
    { decision: "rejected" as const, taskId: null },
  ])("resolves a scoped $decision approval with persisted task lineage $taskId", async ({ decision, taskId }) => {
    const fake = fakeDb(taskId)
    fake.turn.status = "waiting_for_approval"
    fake.turn.revision = 5
    fake.item.id = "agent-wait:approval:approval_1"
    fake.item.status = "started"
    fake.item.revision = 0
    fake.item.content = { waitKind: "approval", approvalId: "approval_1", toolCallId: "call_approval", scopeHash: "scope_hash" }
    const result = await decideApproval(fake.db, {
      waitId: "approval_1", sessionId: "session_1", userId: "user_1", expectedTurnId: "turn_1", expectedRevision: 5,
      clientMessageId: `approval_1_${decision}_${taskId ?? "turn"}`, decision, now: new Date("2026-09-01T00:00:00.000Z"),
    })

    expect(result).toMatchObject({ status: decision, turnId: "turn_1", toolCallId: "call_approval" })
    expect(fake.approval.status).toBe(decision)
    expect(fake.turn.id).toBe("turn_1")
    expect(fake.tx.$queryRaw.mock.calls.some(([query]) =>
      ((query as { strings?: readonly string[] }).strings ?? []).join(" ").includes("pg_advisory_xact_lock"))).toBe(false)
    expect(fake.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "approval.resolved", taskId }),
      expect.objectContaining({ type: "turn.wakeup", taskId: null }),
    ]))
    expect(fake.outbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ topic: "agent.session.event", payload: expect.objectContaining({ type: "approval.resolved", taskId }) }),
      expect.objectContaining({ topic: "agent.turn.wakeup", payload: expect.objectContaining({ type: "turn.wakeup", taskId: null }) }),
    ]))

    const persisted = fake.events.find((event) => event.type === "approval.resolved")
    expect(persisted?.payload).toMatchObject({ status: decision, answerAvailable: false })
    const persistedOutbox = fake.outbox.find((event) => event.topic === "agent.session.event" && event.payload.type === "approval.resolved")
    expect(persistedOutbox?.payload.payload).toMatchObject({ status: decision, answerAvailable: false })
    const timelineRow = persisted && {
      id: persisted.id,
      sessionId: persisted.sessionId,
      turnId: persisted.turnId,
      itemId: persisted.itemId,
      taskId: persisted.taskId,
      sequence: persisted.sequence,
      type: persisted.type,
      actor: persisted.actor,
      payload: persisted.payload,
    }
    const timeline = timelineRow && projectApprovalLedgerRow(timelineRow, "session_1", value => redactSensitiveValue(value, null, 0, 6))
    expect(timeline?.payload).toMatchObject({ status: decision, answerAvailable: false })
    const requested = normalizeTimelineEvent({
      schemaVersion: "agent-harness.v2", id: "request_1", sessionId: "session_1", turnId: "turn_1", itemId: null, taskId,
      type: "approval.requested", actor: "orchestrator", sequence: "9",
      payload: { approvalId: "approval_1", action: "submit_application", revision: 4, scopeHash: `sha256:${"a".repeat(64)}` },
    })
    const resolved = timeline && normalizeTimelineEvent(timeline)
    expect(requested).not.toBeNull()
    expect(resolved).not.toBeNull()
    let state = reduceApprovalLedger(createApprovalLedgerState("session_1"), requested)
    state = reduceApprovalLedger(state, resolved)
    expect(selectApprovalLedgerProjection(state)).toMatchObject({ pendingCount: 0, approvals: [{ status: decision }] })
  })

  it("uses the server-selected reviewed source after the owner locks", async () => {
    const fake = fakeDb("task_approval")
    fake.turn.status = "waiting_for_approval"
    fake.turn.revision = 5
    fake.item.id = "agent-wait:approval:reviewed-application-review:turn_1"
    fake.item.content = { waitKind: "approval", approvalId: "reviewed-application-review:turn_1",
      toolCallId: "review_application:turn_1", scopeHash: "scope_hash" }
    Object.assign(fake.approval, { id: "reviewed-application-review:turn_1", type: "review_application",
      toolCallId: "review_application:turn_1" })
    reviewedDecisionReader.mockResolvedValue({ status: "reviewed_approved", sourceTurnId: "source_turn_server" })

    const result = await decideApproval(fake.db, { waitId: fake.approval.id, sessionId: "session_1", userId: "user_1",
      expectedTurnId: "turn_1", expectedRevision: 5, clientMessageId: "reviewed_approve", decision: "approved",
      receiptNonce: "one-time-nonce", now: new Date("2026-09-01T00:00:00.000Z") })

    expect(result.status).toBe("approved")
    expect(reviewedDecisionReader).toHaveBeenCalledWith(fake.tx, expect.objectContaining({ approvalId: fake.approval.id,
      receiptNonce: "one-time-nonce", requestedSourceTurnId: undefined }))
    const sourceBinding = await import("../approval/reviewed-fill-source-binding")
    expect(sourceBinding.persistReviewedFillSourceInTransaction).toHaveBeenCalledWith(fake.tx, expect.objectContaining({
      sourceTurnId: "source_turn_server", decision: "approved",
    }))
    const sql = (fake.tx.$queryRaw.mock.calls as unknown as Array<[unknown]>).map(([query]) => {
      const queryRecord = query as { strings?: readonly string[] }
      return (queryRecord.strings ?? (Array.isArray(query) ? query as readonly string[] : [])).join(" ")
    })
    const fence = sql.findIndex((query) => query.includes("pg_advisory_xact_lock"))
    const session = sql.findIndex((query) => query.includes('FROM "agent_sessions"'))
    const turn = sql.findIndex((query) => query.includes('FROM "agent_turns"'))
    const task = sql.findIndex((query) => query.includes('FROM "application_tasks"'))
    expect(fence).toBeGreaterThanOrEqual(0)
    expect(fence).toBeLessThan(session)
    expect(session).toBeLessThan(turn)
    expect(turn).toBeLessThan(task)
  })

  it("preserves the legacy reviewed-source selector when no v2 marker exists", async () => {
    const fake = fakeDb("task_approval")
    fake.turn.status = "waiting_for_approval"
    fake.turn.revision = 5
    fake.item.id = "agent-wait:approval:approval_1"
    fake.item.content = { waitKind: "approval", approvalId: "approval_1", toolCallId: "call_approval", scopeHash: "scope_hash" }
    Object.assign(fake.approval, { type: "review_application" })
    await decideApproval(fake.db, { waitId: "approval_1", sessionId: "session_1", userId: "user_1", expectedTurnId: "turn_1",
      expectedRevision: 5, clientMessageId: "legacy_review", decision: "approved", reviewedSourceTurnId: "legacy_source",
      now: new Date("2026-09-01T00:00:00.000Z") })
    const sourceBinding = await import("../approval/reviewed-fill-source-binding")
    expect(sourceBinding.persistReviewedFillSourceInTransaction).toHaveBeenCalledWith(fake.tx, expect.objectContaining({
      decision: "approved", sourceTurnId: "legacy_source",
    }))
    expect(fake.tx.$queryRaw.mock.calls.some(([query]) =>
      ((query as { strings?: readonly string[] }).strings ?? []).join(" ").includes("pg_advisory_xact_lock"))).toBe(false)
  })

  it("does not replay a command for a different decision", async () => {
    const fake = fakeDb()
    fake.turn.status = "waiting_for_approval"
    fake.turn.revision = 5
    fake.item.id = "agent-wait:approval:approval_1"
    fake.item.content = { waitKind: "approval", approvalId: "approval_1", toolCallId: "call_approval", scopeHash: "scope_hash" }
    const shared = { waitId: "approval_1", sessionId: "session_1", userId: "user_1", expectedTurnId: "turn_1",
      expectedRevision: 5, clientMessageId: "approval_reuse", now: new Date("2026-09-01T00:00:00.000Z") }
    await decideApproval(fake.db, { ...shared, decision: "approved" })
    await expect(decideApproval(fake.db, { ...shared, decision: "rejected" })).rejects.toMatchObject({ code: "wait_not_pending" })
    expect(fake.tx.agentApproval.updateMany).toHaveBeenCalledTimes(1)
  })

  it("keeps ordinary approval owner failures mapped to not found", async () => {
    const fake = fakeDb(null, false)
    await expect(decideApproval(fake.db, { waitId: "approval_1", sessionId: "session_1", userId: "user_1",
      expectedTurnId: "turn_1", expectedRevision: 5, clientMessageId: "missing_owner", decision: "approved" }))
      .rejects.toMatchObject({ code: "wait_not_found" })
  })
})
