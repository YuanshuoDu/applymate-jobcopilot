import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(), questionFindFirst: vi.fn(), questionUpdate: vi.fn(),
  executionFindFirst: vi.fn(), executionUpdate: vi.fn(), enqueue: vi.fn(),
}))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))
vi.mock("@/lib/db", () => ({ db: {
  agentRunQuestion: { findFirst: mocks.questionFindFirst, update: mocks.questionUpdate },
  agentExecution: { findFirst: mocks.executionFindFirst, update: mocks.executionUpdate },
} }))
vi.mock("@/lib/agent-run-queue-client", () => ({ enqueueAgentRun: mocks.enqueue }))

function request(answer = "keep_resume") {
  return new Request("http://localhost/api/agent/answer", { method: "POST", body: JSON.stringify({ questionId: "question_1", answer }), headers: { "content-type": "application/json" } })
}

describe("agent answer API", () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.questionFindFirst.mockResolvedValue({ id: "question_1", runId: "session_1", answer: null, options: [{ value: "keep_resume" }, { value: "apply_ai_changes" }] })
    mocks.questionUpdate.mockResolvedValue({})
    mocks.executionFindFirst.mockResolvedValue({ id: "execution_1", sessionId: "session_1" })
    mocks.executionUpdate.mockResolvedValue({})
    mocks.enqueue.mockResolvedValue("worker_1")
  })

  it("validates the offered option and requeues the same waiting execution", async () => {
    const { POST } = await import("./route")
    const response = await POST(request() as never)

    await expect(response.json()).resolves.toMatchObject({ answered: true, resumed: true })
    expect(mocks.executionUpdate).toHaveBeenNthCalledWith(1, expect.objectContaining({ data: expect.objectContaining({ status: "queued" }) }))
    expect(mocks.enqueue).toHaveBeenCalledWith({ userId: "user_1", sessionId: "session_1" })
  })

  it("rejects a value the Agent did not offer", async () => {
    const { POST } = await import("./route")
    const response = await POST(request("invent a new option") as never)
    expect(response.status).toBe(400)
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })
})
