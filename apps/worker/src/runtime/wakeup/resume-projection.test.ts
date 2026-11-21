import { describe, expect, it, vi } from "vitest"

import { appendResumeEvent, hasReviewedApplicationReviewIntent, wakeupLeaseDisposition } from "./resume-projection.js"
import type { AgentTurnWakeupPayload } from "./types.js"

const approval = (status: "approved" | "rejected" = "approved"): AgentTurnWakeupPayload => ({
  eventId: "event-1", sessionId: "session-1", turnId: "turn-1", itemId: "agent-wait:approval:reviewed-application-review:turn-1",
  waitKind: "approval", waitId: "reviewed-application-review:turn-1", toolCallId: "tool-1", status, nextTurnRevision: 4,
})

const reviewedTurn = (overrides: Record<string, unknown> = {}) => ({
  source: "user", executionMode: "canonical_task_graph",
  input: { intent: { kind: "reviewed_application_review", version: 1, sourceTurnId: "source-turn-1", jobId: "job-1" } },
  rootTaskId: "root-1", hasLiveLease: true, ...overrides,
})

const reviewedItem = (decision: "approved" | "rejected" = "approved", overrides: Record<string, unknown> = {}) => ({
  id: "agent-wait:approval:reviewed-application-review:turn-1", type: "approval_request", status: "completed", taskId: null,
  content: {
    waitKind: "approval", approvalId: "reviewed-application-review:turn-1", toolCallId: "tool-1", action: "review_application",
    impact: { externalSubmission: false, jobId: "job-1" }, decision, responseAvailable: true,
    respondedAt: "2026-11-20T10:00:00.000Z",
  }, ...overrides,
})

describe("resume event projection", () => {
  it("writes only the safe wake lineage into the resumed event and outbox", async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => sql.includes("UPDATE \"agent_sessions\"")
      ? { rows: [{ eventSequence: "9" }], rowCount: 1 } : { rows: [], rowCount: 1 })
    const payload = approval()
    await appendResumeEvent({ query } as never, payload, "user-1")

    expect(query).toHaveBeenCalledTimes(3)
    const eventValues = query.mock.calls[1]?.[1] as unknown[]
    const eventPayload = JSON.parse(String(eventValues[7]))
    expect(eventPayload).toEqual({
      waitKind: "approval", waitId: "reviewed-application-review:turn-1", itemId: payload.itemId, turnId: payload.turnId,
      toolCallId: "tool-1", status: "approved", resumedFromEventId: payload.eventId,
    })
    const outboxValues = query.mock.calls[2]?.[1] as unknown[]
    expect(JSON.parse(String(outboxValues[3]))).toMatchObject({ type: "turn.resumed", payload: eventPayload })
    expect(JSON.stringify(query.mock.calls)).not.toContain("answer")
  })

  it("fails before event writes when the session sequence is unavailable", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    await expect(appendResumeEvent({ query } as never, approval(), "user-1")).rejects.toThrow("sequence is unavailable")
    expect(query).toHaveBeenCalledTimes(1)
  })
})

describe("live reviewed application approval wait deferral", () => {
  it.each(["approved", "rejected"] as const)("recognizes the exact resolved %s approval on the same live Turn", status => {
    expect(wakeupLeaseDisposition(approval(status), reviewedTurn(), reviewedItem(status) as never)).toBe("defer")
  })

  it("fails closed for a malformed marked intent and defers only under a live Turn lease", () => {
    const wakeup = approval()
    const item = reviewedItem() as never
    expect(wakeupLeaseDisposition(wakeup, reviewedTurn({ hasLiveLease: false }), item)).toBe("resume")
    expect(wakeupLeaseDisposition(wakeup, reviewedTurn({ source: "automation" }), item)).toBe("wait_scope_mismatch")
    expect(wakeupLeaseDisposition(wakeup, reviewedTurn({ executionMode: "legacy" }), item)).toBe("wait_scope_mismatch")
    expect(wakeupLeaseDisposition(wakeup, reviewedTurn({ input: { intent: { kind: "reviewed_application_review", version: 1, sourceTurnId: "source-turn-1", jobId: "job-1", extra: true } } }), item)).toBe("wait_scope_mismatch")
    expect(hasReviewedApplicationReviewIntent({ intent: { kind: "reviewed_application_review", unexpected: true } })).toBe(true)
    expect(wakeupLeaseDisposition(wakeup, reviewedTurn({ input: {} }), item)).toBe("resume")
  })

  it("requires matching approval identity, decision, and non-submission impact", () => {
    const wakeup = approval()
    const badItems = [
      reviewedItem("approved", { id: "other-item" }),
      reviewedItem("approved", { content: { ...reviewedItem().content as object, approvalId: "other-approval" } }),
      reviewedItem("approved", { content: { ...reviewedItem().content as object, toolCallId: "other-tool" } }),
      reviewedItem("rejected"),
      reviewedItem("approved", { content: { ...reviewedItem().content as object, action: "submit_application" } }),
      reviewedItem("approved", { content: { ...reviewedItem().content as object, impact: { externalSubmission: true, jobId: "job-1" } } }),
      reviewedItem("approved", { content: { ...reviewedItem().content as object, impact: { externalSubmission: false, jobId: "job-2" } } }),
      reviewedItem("approved", { content: { ...reviewedItem().content as object, responseAvailable: false } }),
      reviewedItem("approved", { content: { ...reviewedItem().content as object, respondedAt: "not-a-date" } }),
    ]
    for (const item of badItems) expect(wakeupLeaseDisposition(wakeup, reviewedTurn(), item as never)).toBe("wait_scope_mismatch")
  })

  it("keeps the established scheduled question deferral predicate", () => {
    const question: AgentTurnWakeupPayload = {
      ...approval(), itemId: "agent-wait:question:q1", waitKind: "question", waitId: "q1", toolCallId: "tool-q1", status: "answered",
    }
    const turn = reviewedTurn({ source: "automation", input: { automationRunMode: "scheduled" } })
    const item = { id: question.itemId, type: "question", status: "completed", taskId: "root-1", content: {
      waitKind: "question", waitId: "q1", toolCallId: "tool-q1", answerAvailable: true, answer: "private",
    } }
    expect(wakeupLeaseDisposition(question, turn, item)).toBe("defer")
    expect(wakeupLeaseDisposition(question, turn, { ...item, taskId: "child-1" })).toBe("resume")
  })
})
