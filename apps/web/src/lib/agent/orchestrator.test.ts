import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ findFirst: vi.fn(), create: vi.fn() }))
vi.mock("@/lib/db", () => ({ db: { agentRunQuestion: { findFirst: mocks.findFirst, create: mocks.create } } }))

describe("OrchestratorAgent durable questions", () => {
  beforeEach(() => { mocks.findFirst.mockReset(); mocks.create.mockReset() })

  it("persists an unanswered question then releases the worker", async () => {
    mocks.findFirst.mockResolvedValue(null)
    mocks.create.mockResolvedValue({ id: "question_1" })
    const { AgentPauseError, OrchestratorAgent } = await import("./orchestrator")
    const agent = new OrchestratorAgent({ userId: "user_1", sessionId: "session_1", agentCfg: {} as never, roleConfigs: {} as never, resumeText: "", resumeContent: {} as never, defaultResume: {} as never, aiConfig: {} as never, autonomous: false, emit: vi.fn() })
    await expect(agent.ask("writer", "Tailor resume?", [{ label: "Keep", value: "keep_resume" }])).rejects.toBeInstanceOf(AgentPauseError)
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ runId: "session_1", stage: "writer" }) }))
  })

  it("uses the saved answer after the run is requeued", async () => {
    mocks.findFirst.mockResolvedValue({ id: "question_1", answer: "keep_resume" })
    const { OrchestratorAgent } = await import("./orchestrator")
    const agent = new OrchestratorAgent({ userId: "user_1", sessionId: "session_1", agentCfg: {} as never, roleConfigs: {} as never, resumeText: "", resumeContent: {} as never, defaultResume: {} as never, aiConfig: {} as never, autonomous: false, emit: vi.fn() })
    await expect(agent.ask("writer", "Tailor resume?", [{ label: "Keep", value: "keep_resume" }])).resolves.toBe("keep_resume")
  })

  it("does not reuse an answer from a different question in the same stage", async () => {
    mocks.findFirst.mockResolvedValue(null)
    mocks.create.mockResolvedValue({ id: "question_2" })
    const { AgentPauseError, OrchestratorAgent } = await import("./orchestrator")
    const agent = new OrchestratorAgent({ userId: "user_1", sessionId: "session_1", agentCfg: {} as never, roleConfigs: {} as never, resumeText: "", resumeContent: {} as never, defaultResume: {} as never, aiConfig: {} as never, autonomous: false, emit: vi.fn() })

    await expect(agent.ask("writer", "Use a different template?", [{ label: "No", value: "no" }])).rejects.toBeInstanceOf(AgentPauseError)

    expect(mocks.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ stage: "writer", question: "Use a different template?" }),
    }))
  })
})
