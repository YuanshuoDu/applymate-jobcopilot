import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ upsert: vi.fn(), updateMany: vi.fn() }))
vi.mock("@/lib/db", () => ({ db: { agentExecution: { upsert: mocks.upsert, updateMany: mocks.updateMany } } }))

describe("agent execution control plane", () => {
  beforeEach(() => { mocks.upsert.mockReset(); mocks.updateMany.mockReset() })

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
})
