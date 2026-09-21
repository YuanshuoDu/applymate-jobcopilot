import { beforeEach, describe, expect, it, vi } from "vitest"

import { AgentWaitError } from "@/lib/agent/broker/errors"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(), questionFindFirst: vi.fn(), questionUpdateMany: vi.fn(),
  agentTurnFindFirst: vi.fn(), executionFindFirst: vi.fn(), executionUpdateMany: vi.fn(), executionUpdate: vi.fn(), enqueue: vi.fn(),
  answerLegacyQuestion: vi.fn(),
}))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))
vi.mock("@/lib/db", () => ({ db: {
  agentRunQuestion: { findFirst: mocks.questionFindFirst, updateMany: mocks.questionUpdateMany },
  agentTurn: { findFirst: mocks.agentTurnFindFirst },
  agentExecution: { findFirst: mocks.executionFindFirst, updateMany: mocks.executionUpdateMany, update: mocks.executionUpdate },
} }))
vi.mock("@/lib/agent-run-queue-client", () => ({ enqueueAgentRun: mocks.enqueue }))
vi.mock("@/lib/agent/broker/legacy-question-answer", () => ({ answerLegacyQuestion: mocks.answerLegacyQuestion }))

function request(answer = "keep_resume", clientMessageId?: string) {
  return new Request("http://localhost/api/agent/answer", {
    method: "POST",
    body: JSON.stringify({ questionId: "question_1", answer, ...(clientMessageId ? { clientMessageId } : {}) }),
    headers: { "content-type": "application/json" },
  })
}

describe("agent answer API", () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.questionFindFirst.mockResolvedValue({ id: "question_1", runId: "session_1", answer: null, options: [{ value: "keep_resume" }, { value: "apply_ai_changes" }] })
    mocks.agentTurnFindFirst.mockResolvedValue(null)
    mocks.questionUpdateMany.mockResolvedValue({ count: 1 })
    mocks.executionFindFirst.mockResolvedValue({ id: "execution_1", sessionId: "session_1" })
    mocks.executionUpdateMany.mockResolvedValue({ count: 1 })
    mocks.executionUpdate.mockResolvedValue({})
    mocks.enqueue.mockResolvedValue("worker_1")
    mocks.answerLegacyQuestion.mockResolvedValue({ disposition: "legacy_only", reason: "no_active_turn" })
  })

  it("validates the offered option and requeues the same waiting execution", async () => {
    const { POST } = await import("./route")
    const response = await POST(request() as never)

    await expect(response.json()).resolves.toMatchObject({ answered: true, resumed: true })
    expect(mocks.executionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "queued" }) }))
    expect(mocks.enqueue).toHaveBeenCalledWith({ userId: "user_1", sessionId: "session_1" })
    expect(mocks.answerLegacyQuestion).toHaveBeenCalledWith(expect.anything(), { questionId: "question_1", userId: "user_1", answer: "keep_resume" })
  })

  it("rejects a value the Agent did not offer", async () => {
    const { POST } = await import("./route")
    const response = await POST(request("invent a new option") as never)
    expect(response.status).toBe(400)
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })

  it("quarantines an answer when an active canonical Turn owns the wait", async () => {
    mocks.answerLegacyQuestion.mockResolvedValue({ disposition: "legacy_only", reason: "turn_not_waiting" })
    mocks.agentTurnFindFirst.mockResolvedValue({ id: "turn_1" })
    const { POST } = await import("./route")
    const response = await POST(request() as never)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: "A canonical agent turn owns this wait.", code: "canonical_turn_owns_wait" })
    expect(mocks.questionUpdateMany).not.toHaveBeenCalled()
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })

  it("claims a question once when duplicate answers race", async () => {
    mocks.questionUpdateMany.mockResolvedValue({ count: 0 })
    const { POST } = await import("./route")
    const response = await POST(request() as never)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: "Already answered" })
    expect(mocks.executionUpdateMany).not.toHaveBeenCalled()
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })

  it("returns canonical bridge success without claiming legacy state or promising Worker resume", async () => {
    mocks.answerLegacyQuestion.mockResolvedValue({
      disposition: "bridged", questionId: "question_1", sessionId: "session_1", turnId: "turn_1",
      itemId: "agent-wait:question:question_1", nextTurnRevision: 7, sequence: "12",
    })
    const { POST } = await import("./route")
    const response = await POST(request("keep_resume", "client_1") as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      answered: true,
      answer: "keep_resume",
      resumed: false,
      continuation: "canonical_turn_wakeup_recorded",
      disposition: "bridged",
      nextTurnRevision: 7,
    })
    expect(mocks.answerLegacyQuestion).toHaveBeenCalledWith(expect.anything(), {
      questionId: "question_1", userId: "user_1", answer: "keep_resume", clientMessageId: "client_1",
    })
    expect(mocks.questionFindFirst).not.toHaveBeenCalled()
    expect(mocks.executionUpdateMany).not.toHaveBeenCalled()
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })

  it("treats a canonical duplicate as idempotent success without enqueue", async () => {
    mocks.answerLegacyQuestion.mockResolvedValue({
      disposition: "duplicate", questionId: "question_1", sessionId: "session_1", turnId: "turn_1",
      itemId: "agent-wait:question:question_1", nextTurnRevision: 7, sequence: "12",
    })
    const { POST } = await import("./route")
    const response = await POST(request() as never)

    await expect(response.json()).resolves.toMatchObject({ answered: true, resumed: false, disposition: "duplicate" })
    expect(mocks.questionFindFirst).not.toHaveBeenCalled()
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })

  it("returns a machine-coded bridge_pending conflict without legacy mutation or enqueue", async () => {
    mocks.answerLegacyQuestion.mockResolvedValue({ disposition: "bridge_pending", reason: "canonical_item_missing" })
    const { POST } = await import("./route")
    const response = await POST(request() as never)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: "The canonical question bridge is pending proof.",
      code: "legacy_question_bridge_pending",
      reason: "canonical_item_missing",
    })
    expect(mocks.questionFindFirst).not.toHaveBeenCalled()
    expect(mocks.questionUpdateMany).not.toHaveBeenCalled()
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })

  it("maps service wait errors to their machine code before legacy fallback", async () => {
    mocks.answerLegacyQuestion.mockRejectedValueOnce(new AgentWaitError("wait_invalid_answer", "Invalid answer", 422))
    const { POST } = await import("./route")
    const response = await POST(request() as never)

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({ error: "Invalid answer", code: "wait_invalid_answer" })
    expect(mocks.questionFindFirst).not.toHaveBeenCalled()
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })

  it("reports legacy dispatch failure as dispatch_pending after rollback", async () => {
    mocks.enqueue.mockRejectedValueOnce(new Error("Redis unavailable"))
    const { POST } = await import("./route")
    const response = await POST(request() as never)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: "Redis unavailable",
      code: "dispatch_pending",
      questionId: "question_1",
      resumed: false,
    })
    expect(mocks.questionUpdateMany).toHaveBeenCalledTimes(2)
    expect(mocks.executionUpdateMany).toHaveBeenCalledTimes(2)
  })

  it("keeps auth and body validation ahead of the answer bridge service", async () => {
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
