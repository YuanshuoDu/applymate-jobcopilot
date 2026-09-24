import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ upsert: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn() }))
vi.mock("@/lib/db", () => ({ db: { agentExecution: { upsert: mocks.upsert, updateMany: mocks.updateMany, findFirst: mocks.findFirst } } }))

describe("agent execution control plane", () => {
  beforeEach(() => { mocks.upsert.mockReset(); mocks.updateMany.mockReset(); mocks.findFirst.mockReset() })

  it("creates one durable execution per session", async () => {
    mocks.upsert.mockResolvedValue({ id: "execution_1" })
    const { ensureAgentExecution } = await import("./execution-control")
    await expect(ensureAgentExecution({ userId: "user_1", sessionId: "session_1", autonomous: false })).resolves.toEqual({ id: "execution_1" })
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { sessionId: "session_1" } }))
  })

  it("claims only queued or paused executions", async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 })
    const { claimAgentExecution } = await import("./execution-control")
    await expect(claimAgentExecution({ id: "execution_1", userId: "user_1" })).resolves.toBe(true)
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ OR: expect.any(Array) }) }))
  })

  it("resets a finished execution when an automation starts another cycle", async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 1 })
    mocks.findFirst.mockResolvedValueOnce({ id: "execution_1", status: "queued" })
    const { ensureAgentExecution } = await import("./execution-control")

    await expect(ensureAgentExecution({ userId: "user_1", sessionId: "session_1", autonomous: true, restartForRun: true })).resolves.toEqual({ id: "execution_1", status: "queued" })
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: "user_1", sessionId: "session_1", status: { in: ["completed", "failed", "cancelled"] } },
      data: expect.objectContaining({ status: "queued", checkpoint: "scout", workerTaskId: null }),
    }))
    expect(mocks.upsert).not.toHaveBeenCalled()
  })
})
