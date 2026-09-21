import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(), questionFindFirst: vi.fn(), questionUpdateMany: vi.fn(),
  agentTurnFindFirst: vi.fn(), executionFindFirst: vi.fn(), executionUpdateMany: vi.fn(), executionUpdate: vi.fn(), enqueue: vi.fn(),
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

function request(answer = "keep_resume") {
  return new Request("http://localhost/api/agent/answer", { method: "POST", body: JSON.stringify({ questionId: "question_1", answer }), headers: { "content-type": "application/json" } })
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
  })

  it("validates the offered option and requeues the same waiting execution", async () => {
    const { POST } = await import("./route")
    const response = await POST(request() as never)

    await expect(response.json()).resolves.toMatchObject({ answered: true, resumed: true })
    expect(mocks.executionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "queued" }) }))
    expect(mocks.enqueue).toHaveBeenCalledWith({ userId: "user_1", sessionId: "session_1" })
  })

  it("rejects a value the Agent did not offer", async () => {
    const { POST } = await import("./route")
    const response = await POST(request("invent a new option") as never)
    expect(response.status).toBe(400)
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })

  it("quarantines an answer when an active canonical Turn owns the wait", async () => {
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
})
