import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ findFirst: vi.fn(), create: vi.fn(), modelChat: vi.fn() }))
vi.mock("@/lib/db", () => ({ db: { agentRunQuestion: { findFirst: mocks.findFirst, create: mocks.create } } }))
vi.mock("@/lib/model-router", () => ({ modelChat: mocks.modelChat }))

async function makeAgent() {
  const { OrchestratorAgent } = await import("./orchestrator")
  const emit = vi.fn()
  const agent = new OrchestratorAgent({
    userId: "user_1",
    sessionId: "session_1",
    agentCfg: {
      id: "agent_1",
      userId: "user_1",
      isRunning: true,
      dailyLimit: 10,
      minMatchScore: 70,
      autoApply: false,
      requireApproval: true,
      targetLocations: ["Dublin"],
      targetRoles: ["Software Engineer"],
      excludeCompanies: [],
      priorityCompanies: [],
      autoCoverLetter: false,
      coverTone: "professional",
      useTailoredCV: true,
      model: "MiniMax-M3",
    },
    roleConfigs: {} as never,
    resumeText: "",
    resumeContent: {} as never,
    defaultResume: {} as never,
    aiConfig: {} as never,
    autonomous: false,
    emit,
  })
  return { agent, emit }
}

describe("OrchestratorAgent durable questions", () => {
  beforeEach(() => { mocks.findFirst.mockReset(); mocks.create.mockReset(); mocks.modelChat.mockReset() })

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

describe("OrchestratorAgent evaluation", () => {
  beforeEach(() => { mocks.modelChat.mockReset() })

  it.each([
    ["proceed", '{"decision":"proceed","thinking":"Continue with the next stage"}'],
    ["retry", '{"decision":"retry","thinking":"Retry with a safe adjustment","retry_fix":{"dailyLimit":20}}'],
    ["ask_user", '{"decision":"ask_user","thinking":"A user choice is required","ask_question":"Continue?"}'],
    ["abort", '{"decision":"abort","thinking":"The pipeline cannot continue safely"}'],
  ])("preserves the legal %s decision", async (decision, text) => {
    mocks.modelChat.mockResolvedValue({ text })
    const { agent } = await makeAgent()

    await expect(agent.evaluate("scout", "Found one job", { jobCount: 1 })).resolves.toMatchObject({ decision })
  })

  it("fails closed when the model returns malformed JSON", async () => {
    mocks.modelChat.mockResolvedValue({ text: "not JSON" })
    const { agent } = await makeAgent()

    const result = await agent.evaluate("scout", "Found one job", { jobCount: 1 })

    expect(result.decision).not.toBe("proceed")
    expect(result.decision).toBe("abort")
  })

  it("fails closed when the model omits a decision", async () => {
    mocks.modelChat.mockResolvedValue({ text: '{"thinking":"Continue safely"}' })
    const { agent } = await makeAgent()

    const result = await agent.evaluate("scout", "Found one job", { jobCount: 1 })

    expect(result.decision).not.toBe("proceed")
    expect(result.decision).toBe("abort")
  })

  it("fails closed when the model returns an unknown decision", async () => {
    mocks.modelChat.mockResolvedValue({ text: '{"decision":"skip","thinking":"Skip ahead"}' })
    const { agent } = await makeAgent()

    const result = await agent.evaluate("scout", "Found one job", { jobCount: 1 })

    expect(result.decision).not.toBe("proceed")
    expect(result.decision).toBe("abort")
  })

  it("fails closed when modelChat throws without exposing the provider error", async () => {
    mocks.modelChat.mockRejectedValue(new Error("provider secret token"))
    const { agent, emit } = await makeAgent()

    const result = await agent.evaluate("scout", "Found one job", { jobCount: 1 })

    expect(result.decision).not.toBe("proceed")
    expect(result.decision).toBe("abort")
    expect(result.thinking).not.toContain("provider secret token")
    expect(emit).toHaveBeenCalledWith("orchestrator_thinking", expect.objectContaining({ decision: "abort" }))
  })
})
