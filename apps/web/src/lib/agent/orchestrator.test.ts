import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ findFirst: vi.fn(), create: vi.fn(), modelChat: vi.fn() }))
vi.mock("@/lib/db", () => ({ db: { agentRunQuestion: { findFirst: mocks.findFirst, create: mocks.create } } }))
vi.mock("@/lib/model-router", () => ({ modelChat: mocks.modelChat }))

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

describe("OrchestratorAgent.evaluate fail-closed decisions", () => {
  beforeEach(() => { mocks.findFirst.mockReset(); mocks.create.mockReset(); mocks.modelChat.mockReset() })

  async function createAgent(autonomous = false) {
    const { OrchestratorAgent } = await import("./orchestrator")
    const emit = vi.fn()
    const agent = new OrchestratorAgent({
      userId: "user_1", sessionId: "session_1",
      agentCfg: { minMatchScore: 70, dailyLimit: 10, autoApply: false } as never,
      roleConfigs: {} as never, resumeText: "", resumeContent: {} as never,
      defaultResume: {} as never, aiConfig: {} as never, autonomous, emit,
    }, autonomous)
    return { agent, emit }
  }

  it.each([
    ["proceed", { decision: "proceed", thinking: "The stage output is ready to continue." }],
    ["abort", { decision: "abort", thinking: "The pipeline cannot safely continue." }],
    ["retry", { decision: "retry", thinking: "Retry with a concrete fix.", retry_fix: { dailyLimit: 20 } }],
  ])("accepts valid %s decisions", async (_name, decision) => {
    mocks.modelChat.mockResolvedValue({ text: JSON.stringify(decision) })
    const { agent } = await createAgent()

    await expect(agent.evaluate("scout", "Found one job", { jobCount: 1 })).resolves.toEqual(decision)
  })

  it("accepts ask_user interactively and rejects it in autonomous mode", async () => {
    const response = {
      decision: "ask_user", thinking: "The candidate must choose an option.",
      ask_question: "Which resume should be used?", ask_options: [{ label: "Current resume", value: "current" }],
    }
    mocks.modelChat.mockResolvedValue({ text: JSON.stringify(response) })
    const { agent: interactive } = await createAgent(false)
    const { agent: autonomous, emit } = await createAgent(true)
    const { OrchestratorDecisionError } = await import("./orchestrator")

    await expect(interactive.evaluate("scout", "Found one job", { jobCount: 1 })).resolves.toEqual(response)
    await expect(autonomous.evaluate("scout", "Found one job", { jobCount: 1 })).rejects.toBeInstanceOf(OrchestratorDecisionError)
    expect(emit).not.toHaveBeenCalled()
  })

  it("turns malformed JSON into a typed sanitized failure", async () => {
    mocks.modelChat.mockResolvedValue({ text: "{ definitely not valid JSON" })
    const { agent, emit } = await createAgent()
    const { OrchestratorDecisionError } = await import("./orchestrator")

    const error = await agent.evaluate("scout", "Found one job", { jobCount: 1 }).catch(value => value)
    expect(error).toBeInstanceOf(OrchestratorDecisionError)
    expect(error).toMatchObject({ code: "orchestrator_decision_invalid" })
    expect(error.message).not.toContain("definitely")
    expect(emit).not.toHaveBeenCalled()
  })

  it("rejects unknown decisions", async () => {
    mocks.modelChat.mockResolvedValue({ text: JSON.stringify({ decision: "continue", thinking: "Continue safely." }) })
    const { agent } = await createAgent()
    const { OrchestratorDecisionError } = await import("./orchestrator")

    await expect(agent.evaluate("scout", "Found one job", { jobCount: 1 })).rejects.toBeInstanceOf(OrchestratorDecisionError)
  })

  it.each([
    ["missing ask_user question", { decision: "ask_user", thinking: "A choice is needed." }],
    ["malformed ask_user options", { decision: "ask_user", thinking: "A choice is needed.", ask_question: "Choose one.", ask_options: "continue" }],
    ["oversized ask_user question", { decision: "ask_user", thinking: "A choice is needed.", ask_question: "q".repeat(501) }],
    ["missing retry fix", { decision: "retry", thinking: "A retry is needed." }],
    ["malformed retry fix", { decision: "retry", thinking: "A retry is needed.", retry_fix: "dailyLimit=20" }],
    ["oversized retry fix", { decision: "retry", thinking: "A retry is needed.", retry_fix: { config: "x".repeat(2_001) } }],
  ])("rejects %s", async (_name, decision) => {
    mocks.modelChat.mockResolvedValue({ text: JSON.stringify(decision) })
    const { agent } = await createAgent()
    const { OrchestratorDecisionError } = await import("./orchestrator")

    await expect(agent.evaluate("scout", "Found one job", { jobCount: 1 })).rejects.toBeInstanceOf(OrchestratorDecisionError)
  })

  it("sanitizes provider rejection details", async () => {
    mocks.modelChat.mockRejectedValue(new Error("provider secret: token-123"))
    const { agent } = await createAgent()
    const { OrchestratorDecisionError } = await import("./orchestrator")

    await expect(agent.evaluate("scout", "Found one job", { jobCount: 1 })).rejects.toMatchObject({
      name: "OrchestratorDecisionError",
      code: "orchestrator_decision_invalid",
      message: expect.not.stringContaining("token-123"),
    })
  })
})
