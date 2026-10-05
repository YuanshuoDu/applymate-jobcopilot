import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ findFirst: vi.fn(), create: vi.fn(), modelChat: vi.fn(), updateMany: vi.fn() }))
vi.mock("@/lib/db", () => ({
  db: {
    agentRunQuestion: { findFirst: mocks.findFirst, create: mocks.create },
    agentConfig: { updateMany: mocks.updateMany },
  },
}))
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
  beforeEach(() => { mocks.findFirst.mockReset(); mocks.create.mockReset(); mocks.modelChat.mockReset(); mocks.updateMany.mockReset() })

  async function createAgent(autonomous = false, throttleMs = 300) {
    const { OrchestratorAgent } = await import("./orchestrator")
    const emit = vi.fn()
    const agentCfg = {
      id: "config_1", userId: "user_1", isRunning: false,
      minMatchScore: 70, dailyLimit: 10, autoApply: false, requireApproval: true,
      targetLocations: ["Berlin"], targetRoles: ["Engineer"],
      excludeCompanies: ["Blocked GmbH"], priorityCompanies: [],
      autoCoverLetter: true, coverTone: "professional", useTailoredCV: true,
      model: "MiniMax-M3", throttleMs,
    }
    const agent = new OrchestratorAgent({
      userId: "user_1", sessionId: "session_1",
      agentCfg: agentCfg as never,
      roleConfigs: {} as never, resumeText: "", resumeContent: {} as never,
      defaultResume: {} as never, aiConfig: {} as never, autonomous, emit,
    }, autonomous)
    return { agent, emit, agentCfg }
  }

  it.each([
    ["proceed", { decision: "proceed", thinking: "The stage output is ready to continue." }],
    ["abort", { decision: "abort", thinking: "The pipeline cannot safely continue." }],
    ["retry", { decision: "retry", thinking: "Retry with a concrete fix.", retry_fix: { throttleMs: 500 } }],
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
    ["malformed retry fix", { decision: "retry", thinking: "A retry is needed.", retry_fix: "throttleMs=500" }],
    ["unknown retry field", { decision: "retry", thinking: "A retry is needed.", retry_fix: { unknownField: 500 } }],
  ])("rejects %s", async (_name, decision) => {
    mocks.modelChat.mockResolvedValue({ text: JSON.stringify(decision) })
    const { agent } = await createAgent()
    const { OrchestratorDecisionError } = await import("./orchestrator")

    await expect(agent.evaluate("scout", "Found one job", { jobCount: 1 })).rejects.toBeInstanceOf(OrchestratorDecisionError)
  })

  it("accepts a slower Scout or Analyst retry adjustment in memory only", async () => {
    const { agent: scoutAgent, agentCfg: scoutCfg, emit: scoutEmit } = await createAgent(false, 300)
    mocks.modelChat.mockResolvedValue({ text: JSON.stringify({
      decision: "retry", thinking: "Slowing the next pass should reduce provider pressure.", retry_fix: { throttleMs: 900 },
    }) })
    const scoutDecision = await scoutAgent.evaluate("scout", "Found one job", { jobCount: 1 })
    expect(scoutDecision.retry_fix).toEqual({ throttleMs: 900 })
    scoutAgent.applyFix(scoutDecision.retry_fix!, "scout")
    expect(scoutCfg.throttleMs).toBe(900)
    expect(scoutEmit).toHaveBeenCalledWith("orchestrator_fix", expect.objectContaining({ stage: "scout", fix: "throttleMs=900" }))
    scoutAgent.complete({ processed: 1, applied: 0, queued: 0, pending: 0, skipped: 0 })
    expect(scoutEmit).toHaveBeenCalledWith("orchestrator_complete", expect.objectContaining({ totalRetries: 1 }))

    const { agent: analystAgent, agentCfg: analystCfg } = await createAgent(false, 400)
    mocks.modelChat.mockResolvedValue({ text: JSON.stringify({
      decision: "retry", thinking: "Slowing the next pass should reduce provider pressure.", retry_fix: { throttleMs: 60_000 },
    }) })
    const analystDecision = await analystAgent.evaluate("analyst", "Scored jobs", { scored: 1 })
    expect(analystDecision.retry_fix).toEqual({ throttleMs: 60_000 })
    analystAgent.applyFix(analystDecision.retry_fix!, "analyst")
    expect(analystCfg.throttleMs).toBe(60_000)
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })

  it.each([
    ["faster throttle", { throttleMs: 299 }],
    ["throttle above hard maximum", { throttleMs: 60_001 }],
    ["fractional throttle", { throttleMs: 300.5 }],
    ["string throttle", { throttleMs: "500" }],
    ["negative throttle", { throttleMs: -1 }],
    ["consent field", { requireApproval: false }],
    ["automation mode", { autoApply: true }],
    ["daily limit", { dailyLimit: 50 }],
    ["match threshold", { minMatchScore: 1 }],
    ["target roles and locations", { targetRoles: ["Any role"], targetLocations: ["Anywhere"] }],
    ["exclusions", { excludeCompanies: [] }],
    ["model choice", { model: "other-model" }],
    ["cover letter settings", { autoCoverLetter: false, coverTone: "casual" }],
    ["arbitrary string and array fields", { unknown: "value", arbitrary: ["value"] }],
    ["valid throttle mixed with a forbidden field", { throttleMs: 500, dailyLimit: 50 }],
  ])("rejects %s without changing runtime config", async (_name, retryFix) => {
    mocks.modelChat.mockResolvedValue({ text: JSON.stringify({
      decision: "retry", thinking: "Try another pass.", retry_fix: retryFix,
    }) })
    const { agent, agentCfg, emit } = await createAgent(false, 300)
    const originalConfig = structuredClone(agentCfg)
    const { OrchestratorDecisionError } = await import("./orchestrator")

    await expect(agent.evaluate("analyst", "Scored jobs", { scored: 1 })).rejects.toBeInstanceOf(OrchestratorDecisionError)

    expect(agentCfg).toEqual(originalConfig)
    expect(emit).not.toHaveBeenCalled()
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })

  it.each(["post-run", "audit", "writer"])("rejects retry fixes from non-retryable stage %s", async stage => {
    mocks.modelChat.mockResolvedValue({ text: JSON.stringify({
      decision: "retry", thinking: "Try another pass.", retry_fix: { throttleMs: 500 },
    }) })
    const { agent, agentCfg, emit } = await createAgent(false, 300)
    const originalConfig = structuredClone(agentCfg)
    const { OrchestratorDecisionError } = await import("./orchestrator")

    await expect(agent.evaluate(stage, "Stage finished", {})).rejects.toBeInstanceOf(OrchestratorDecisionError)
    expect(agentCfg).toEqual(originalConfig)
    expect(emit).not.toHaveBeenCalled()
  })

  it("rejects an invalid direct retry fix before mutation", async () => {
    const { agent, agentCfg } = await createAgent(false, 300)
    const originalConfig = structuredClone(agentCfg)
    const { OrchestratorDecisionError } = await import("./orchestrator")

    expect(() => agent.applyFix({ throttleMs: 500, autoApply: true }, "scout")).toThrow(OrchestratorDecisionError)
    expect(agentCfg).toEqual(originalConfig)
  })

  it("preserves system-owned named fixes separately from model retry patches", async () => {
    const { agent, agentCfg } = await createAgent(false, 300)

    agent.applyFix("all_scoring_failed", "analyst")

    expect(agentCfg.model).toBe("claude-sonnet-5")
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
