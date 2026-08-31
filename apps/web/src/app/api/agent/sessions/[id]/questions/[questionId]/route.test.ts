import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  answerQuestion: vi.fn(),
}))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))
vi.mock("@/lib/db", () => ({ db: {} }))
vi.mock("@/lib/agent/broker/store", () => ({ answerQuestion: mocks.answerQuestion }))

const context = { params: Promise.resolve({ id: "session_1", questionId: "question_1" }) }

function request(body: unknown) {
  return new Request("http://localhost/api/agent/sessions/session_1/questions/question_1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("question answer command API", () => {
  beforeEach(() => {
    mocks.requireAuth.mockReset()
    mocks.answerQuestion.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.answerQuestion.mockResolvedValue({ waitKind: "question", waitId: "question_1", disposition: "resolved", status: "answered", turnId: "turn_1", itemId: "item_1", toolCallId: "call_1", nextTurnRevision: 6, sequence: "12" })
  })

  it("accepts a reconnect-safe typed answer", async () => {
    const { POST } = await import("./route")
    const response = await POST(request({ clientMessageId: "answer_1", expectedTurnId: "turn_1", expectedRevision: 5, answer: "yes" }) as never, context)

    expect(response.status).toBe(202)
    expect(mocks.answerQuestion).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sessionId: "session_1", userId: "user_1", waitId: "question_1", answer: "yes" }))
  })

  it("rejects an empty answer without dispatching", async () => {
    const { POST } = await import("./route")
    const response = await POST(request({ clientMessageId: "empty", expectedTurnId: "turn_1", expectedRevision: 5, answer: " " }) as never, context)

    expect(response.status).toBe(422)
    expect(mocks.answerQuestion).not.toHaveBeenCalled()
  })
})
