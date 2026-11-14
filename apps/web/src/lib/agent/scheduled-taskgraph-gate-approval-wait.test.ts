import { describe, expect, it, vi } from "vitest"
import type { Prisma } from "@prisma/client"
import { SCHEDULED_GATE_REVIEW_MARKER_SCHEMA } from "./approval/gate-replay"
import { scheduledTaskGraphGateApprovalWaitIds } from "./scheduled-taskgraph-gate-approval-wait"

const owner = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
  rootAttemptCount: 2, turnLeaseOwnerId: "root-lease", turnLeaseVersion: 4 }
const gateTaskId = "gate-1"
const now = new Date("2026-11-14T12:00:00.000Z")
const expiresAt = new Date(now.getTime() + 60_000)

type ApprovalFixture = {
  id: string; userId: string; sessionId: string; turnId: string; taskId: string; jobId: string; toolCallId: string
  type: string; status: string; title: string; body: string; impact: Record<string, unknown>; payload: Record<string, unknown>
  scopeHash: string; revision: number; expiresAt: Date; decidedAt: Date | null; consumedAt: Date | null
}
type ItemFixture = {
  id: string; sessionId: string; turnId: string; stepId: string | null; taskId: string | null
  type: string; status: string; revision: number; startedAt: Date | null; completedAt: Date | null; content: Record<string, unknown>
}
type EventFixture = {
  id: string; sessionId: string; turnId: string; itemId: string | null; taskId: string | null
  type: string; actor: string; correlationId: string; idempotencyKey: string; payload: Record<string, unknown>
}

function approval(id = "approval-1", overrides: Partial<ApprovalFixture> = {}): ApprovalFixture {
  const jobId = "job-" + id, taskId = "application-task-" + id
  return {
    id, userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, taskId, jobId, toolCallId: "call-" + id,
    type: "review_application", status: "pending", title: "Review application", body: "Review materials",
    impact: { externalSubmission: false, jobId },
    payload: { jobId, applicationTaskId: taskId,
      scheduledGateReview: { schemaVersion: SCHEDULED_GATE_REVIEW_MARKER_SCHEMA, gateTaskId } },
    scopeHash: "scope-" + id, revision: 3, expiresAt, decidedAt: null, consumedAt: null,
    ...overrides,
  }
}
function item(row = approval(), overrides: Partial<ItemFixture> = {}): ItemFixture {
  return {
    id: "agent-wait:approval:" + row.id, sessionId: row.sessionId, turnId: row.turnId, stepId: null, taskId: null,
    type: "approval_request", status: "started", revision: 0, startedAt: new Date(now.getTime() - 1_000), completedAt: null,
    content: { waitKind: "approval", approvalId: row.id, toolCallId: row.toolCallId, action: "review_application",
      title: row.title, body: row.body, impact: row.impact, scopeHash: row.scopeHash, receiptRevision: row.revision,
      expiresAt: row.expiresAt.toISOString(), decision: null },
    ...overrides,
  }
}
function event(row = approval(), overrides: Partial<EventFixture> = {}): EventFixture {
  return {
    id: "event-" + row.id, sessionId: row.sessionId, turnId: row.turnId, itemId: null, taskId: row.taskId,
    type: "approval.requested", actor: "orchestrator", correlationId: row.id,
    idempotencyKey: "approval:" + row.id + ":requested",
    payload: { approvalId: row.id, action: "review_application", scopeHash: row.scopeHash, revision: row.revision },
    ...overrides,
  }
}
function transaction(rows: ApprovalFixture[] = [approval()], itemRows: unknown[] = [item()], eventRows: unknown[] = [event()]) {
  const approvalFindMany = vi.fn(async () => rows)
  const itemFindMany = vi.fn(async () => itemRows)
  const eventFindMany = vi.fn(async () => eventRows)
  return {
    client: { agentApproval: { findMany: approvalFindMany }, agentItem: { findMany: itemFindMany },
      agentEvent: { findMany: eventFindMany } } as unknown as Prisma.TransactionClient,
    approvalFindMany, itemFindMany, eventFindMany,
  }
}

describe("Scheduled Gate approval wait witness", () => {
  it("accepts multiple same-Gate pending package receipts and ignores unrelated approvals", async () => {
    const first = approval("approval-1")
    const second = approval("approval-2")
    const unrelated = approval("approval-other", { payload: { jobId: "job-other", applicationTaskId: "application-task-other",
      scheduledGateReview: { schemaVersion: SCHEDULED_GATE_REVIEW_MARKER_SCHEMA, gateTaskId: "other-gate" } } })
    const test = transaction([second, unrelated, first], [item(second), item(unrelated), item(first)],
      [event(second), event(unrelated), event(first)])

    await expect(scheduledTaskGraphGateApprovalWaitIds(test.client, owner, gateTaskId, now))
      .resolves.toEqual(["approval-1", "approval-2"])
    expect(test.approvalFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, type: "review_application",
        status: "pending", decidedAt: null, consumedAt: null, expiresAt: { gt: now },
        payload: { path: ["scheduledGateReview", "gateTaskId"], equals: gateTaskId } },
    }))
    expect(test.itemFindMany).toHaveBeenCalledOnce()
    expect(test.eventFindMany).toHaveBeenCalledOnce()
  })

  it.each([
    ["rejected", { status: "rejected", decidedAt: now }],
    ["revoked", { status: "revoked", decidedAt: now }],
    ["already approved", { status: "approved", decidedAt: now }],
    ["consumed", { status: "consumed", consumedAt: now }],
    ["expired", { expiresAt: new Date(now.getTime() - 1) }],
    ["foreign user", { userId: "other-user" }],
    ["foreign session", { sessionId: "other-session" }],
    ["foreign turn", { turnId: "other-turn" }],
    ["wrong action", { type: "submit_application" }],
    ["external submission impact", { impact: { externalSubmission: true, jobId: "job-approval-1" } }],
    ["wrong Gate marker", { payload: { jobId: "job-approval-1", applicationTaskId: "application-task-approval-1",
      scheduledGateReview: { schemaVersion: SCHEDULED_GATE_REVIEW_MARKER_SCHEMA, gateTaskId: "other-gate" } } }],
    ["missing Gate marker", { payload: { jobId: "job-approval-1", applicationTaskId: "application-task-approval-1" } }],
    ["task mismatch", { payload: { jobId: "job-approval-1", applicationTaskId: "other-task",
      scheduledGateReview: { schemaVersion: SCHEDULED_GATE_REVIEW_MARKER_SCHEMA, gateTaskId } } }],
  ])("does not use a %s receipt as a witness", async (_label, overrides) => {
    const row = approval("approval-1", overrides)
    await expect(scheduledTaskGraphGateApprovalWaitIds(transaction([row]).client, owner, gateTaskId, now)).resolves.toEqual([])
  })

  const malformedWitnessCases: Array<[string, (row: ApprovalFixture) => { items: unknown[]; events: unknown[] }]> = [
    ["mismatched item identity", row => ({ items: [item(row, { content: { ...item(row).content, approvalId: "other" } })], events: [event(row)] })],
    ["completed item", row => ({ items: [item(row, { status: "completed" })], events: [event(row)] })],
    ["item with a task binding", row => ({ items: [item(row, { taskId: row.taskId })], events: [event(row)] })],
    ["mismatched request event", row => ({ items: [item(row)], events: [event(row, { payload: { ...event(row).payload, scopeHash: "other" } })] })],
    ["duplicate active items", row => ({ items: [item(row), item(row)], events: [event(row)] })],
    ["duplicate request events", row => ({ items: [item(row)], events: [event(row), event(row)] })],
  ]
  it.each(malformedWitnessCases)("rejects a %s", async (_label, build) => {
    const row = approval()
    const evidence = build(row)
    const test = transaction([row], evidence.items, evidence.events)
    await expect(scheduledTaskGraphGateApprovalWaitIds(test.client, owner, gateTaskId, now)).resolves.toEqual([])
  })

  it("fails closed when the approval candidate set exceeds the bound", async () => {
    const rows = Array.from({ length: 51 }, (_, index) => approval("approval-" + index))
    const test = transaction(rows)
    await expect(scheduledTaskGraphGateApprovalWaitIds(test.client, owner, gateTaskId, now)).resolves.toEqual([])
    expect(test.itemFindMany).not.toHaveBeenCalled()
    expect(test.eventFindMany).not.toHaveBeenCalled()
  })
})