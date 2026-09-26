import { beforeEach, describe, expect, it, vi } from "vitest"

import { AgentWaitError } from "@/lib/agent/broker/errors"

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), answerLegacyQuestion: vi.fn() }))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))
vi.mock("@/lib/db", () => ({ db: {} }))
vi.mock("@/lib/agent/broker/legacy-question-answer", () => ({ answerLegacyQuestion: mocks.answerLegacyQuestion }))

function request(answer = "keep_resume", clientMessageId?: string, questionId = "question_1") {
  return new Request("http://localhost/api/agent/answer", {
    method: "POST",
    body: JSON.stringify({ questionId, answer, ...(clientMessageId ? { clientMessageId } : {}) }),
    headers: { "content-type": "application/json" },
  })
}

describe("agent answer API", () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.answerLegacyQuestion.mockResolvedValue({ disposition: "legacy_only", reason: "no_active_turn" })
  })

  it("reports an unnamespaced default-off answer accepted from its durable dispatch intent", async () => {
    mocks.answerLegacyQuestion.mockResolvedValue({
      disposition: "legacy_dispatch_accepted", questionId: "question_1", sessionId: "session_1",
      executionId: "execution_1", attemptCount: 7, outboxId: "outbox_1", idempotencyKey: "dispatch-key-1",
    })
    const { POST } = await import("./route")
    const response = await POST(request(" keep_resume ", "client_1") as never)

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({
      accepted: true, answered: true, questionId: "question_1", answer: "keep_resume", resumed: false,
      disposition: "legacy_dispatch_accepted", dispatchStatus: "pending", dispatchIntentId: "outbox_1",
      dispatchIdempotencyKey: "dispatch-key-1",
    })
    expect(mocks.answerLegacyQuestion).toHaveBeenCalledWith(expect.anything(), {
      questionId: "question_1", userId: "user_1", answer: " keep_resume ", clientMessageId: "client_1",
    })
  })

  it("reports the same-answer duplicate as pending without a second dispatch", async () => {
    mocks.answerLegacyQuestion
      .mockResolvedValueOnce({
        disposition: "legacy_dispatch_accepted", questionId: "question_1", sessionId: "session_1",
        executionId: "execution_1", attemptCount: 7, outboxId: "outbox_1", idempotencyKey: "dispatch-key-1",
      })
      .mockResolvedValueOnce({
        disposition: "legacy_dispatch_pending", questionId: "question_1", sessionId: "session_1",
        executionId: "execution_1", attemptCount: 7, outboxId: "outbox_1", idempotencyKey: "dispatch-key-1",
      })
    const { POST } = await import("./route")

    const first = await POST(request() as never)
    const duplicate = await POST(request() as never)

    expect(first.status).toBe(202)
    expect(duplicate.status).toBe(202)
    await expect(duplicate.json()).resolves.toMatchObject({
      accepted: true, answered: true, disposition: "legacy_dispatch_pending", dispatchStatus: "pending",
      dispatchIntentId: "outbox_1", dispatchIdempotencyKey: "dispatch-key-1",
    })
  })

  it("keeps answer-only legacy behavior when there is no resumable execution", async () => {
    mocks.answerLegacyQuestion.mockResolvedValue({
      disposition: "legacy_answered", questionId: "question_1", sessionId: "session_1", answer: "keep_resume",
    })
    const { POST } = await import("./route")
    const response = await POST(request() as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ answered: true, resumed: false, disposition: "legacy_answered" })
  })

  it("reports a Turn-owned default-off answer accepted from its durable intent", async () => {
    mocks.answerLegacyQuestion.mockResolvedValue({
      disposition: "legacy_dispatch_accepted", questionId: "agent-question:turn_1:legacy:q1",
      sessionId: "session_1", turnId: "turn_1", executionId: "execution_1", attemptCount: 7,
      outboxId: "outbox_1", idempotencyKey: "dispatch-key-1",
    })
    const { POST } = await import("./route")
    const response = await POST(request("keep_resume", undefined, "agent-question:turn_1:legacy:q1") as never)

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({
      accepted: true, disposition: "legacy_dispatch_accepted", dispatchIntentId: "outbox_1", turnId: "turn_1",
    })
  })

  it("quarantines an answer when a canonical Turn owns the wait", async () => {
    mocks.answerLegacyQuestion.mockResolvedValue({ disposition: "legacy_only", reason: "active_turn_owns_wait" })
    const { POST } = await import("./route")
    const response = await POST(request() as never)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: "A canonical agent turn owns this wait.", code: "canonical_turn_owns_wait" })
  })

  it("does not accept a namespaced question after its Turn stops waiting", async () => {
    mocks.answerLegacyQuestion.mockResolvedValue({ disposition: "legacy_only", reason: "turn_not_waiting" })
    const { POST } = await import("./route")
    const response = await POST(request("keep_resume", undefined, "agent-question:turn_1:legacy:q1") as never)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ code: "legacy_question_turn_not_waiting" })
  })

  it("does not dispatch a namespaced question without its session owner", async () => {
    mocks.answerLegacyQuestion.mockResolvedValue({ disposition: "legacy_only", reason: "session_unmapped" })
    const { POST } = await import("./route")
    const response = await POST(request("keep_resume", undefined, "agent-question:turn_1:legacy:q1") as never)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ code: "legacy_question_session_unmapped" })
  })

  it("fails closed if a persisted dispatch key conflicts with the expected intent", async () => {
    mocks.answerLegacyQuestion.mockResolvedValue({
      disposition: "legacy_dispatch_conflict", questionId: "question_1", sessionId: "session_1",
      executionId: "execution_1", attemptCount: 7,
    })
    const { POST } = await import("./route")
    const response = await POST(request() as never)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ code: "dispatch_intent_conflict" })
  })

  it("returns canonical bridge success without promising Worker resume", async () => {
    mocks.answerLegacyQuestion.mockResolvedValue({
      disposition: "bridged", questionId: "question_1", sessionId: "session_1", turnId: "turn_1",
      itemId: "agent-wait:question:question_1", nextTurnRevision: 7, sequence: "12",
    })
    const { POST } = await import("./route")
    const response = await POST(request("keep_resume", "client_1") as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ answered: true, resumed: false, disposition: "bridged" })
  })

  it("treats a canonical duplicate as idempotent success", async () => {
    mocks.answerLegacyQuestion.mockResolvedValue({
      disposition: "duplicate", questionId: "question_1", sessionId: "session_1", turnId: "turn_1",
      itemId: "agent-wait:question:question_1", nextTurnRevision: 7, sequence: "12",
    })
    const { POST } = await import("./route")
    const response = await POST(request() as never)

    await expect(response.json()).resolves.toMatchObject({ answered: true, resumed: false, disposition: "duplicate" })
  })

  it("maps wait validation errors before fallback", async () => {
    mocks.answerLegacyQuestion.mockRejectedValueOnce(new AgentWaitError("wait_invalid_answer", "Invalid answer", 422))
    const { POST } = await import("./route")
    const response = await POST(request() as never)

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({ error: "Invalid answer", code: "wait_invalid_answer" })
  })

  it("fails closed if an unnamespaced broker path has no durable no-Turn result", async () => {
    mocks.answerLegacyQuestion.mockResolvedValue({ disposition: "legacy_only", reason: "no_active_turn" })
    const { POST } = await import("./route")
    const response = await POST(request() as never)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ code: "legacy_question_not_waiting" })
  })

  it("keeps auth and body validation ahead of the answer service", async () => {
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    const { POST } = await import("./route")
    const unauthorized = await POST(request() as never)
    expect(unauthorized.status).toBe(401)
    expect(mocks.answerLegacyQuestion).not.toHaveBeenCalled()

    mocks.requireAuth.mockResolvedValueOnce({ userId: "user_1" })
    const invalid = await POST(new Request("http://localhost/api/agent/answer", {
      method: "POST", body: JSON.stringify({ questionId: "question_1", answer: " " }),
      headers: { "content-type": "application/json" },
    }) as never)
    expect(invalid.status).toBe(400)
    expect(mocks.answerLegacyQuestion).not.toHaveBeenCalled()
  })
})
