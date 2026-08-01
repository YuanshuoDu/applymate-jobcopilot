import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  scout: vi.fn(), analyze: vi.fn(), prepare: vi.fn(), gate: vi.fn(), execute: vi.fn(), audit: vi.fn(),
  checkpoint: vi.fn(),
}))

vi.mock("./stages/scout", () => ({ runScout: mocks.scout, acceptScout: vi.fn(() => ({ ok: true })) }))
vi.mock("./stages/analyze", () => ({ runAnalyze: mocks.analyze, acceptAnalyze: vi.fn(() => ({ ok: true })) }))
vi.mock("./stages/prepare", () => ({ runPrepare: mocks.prepare, acceptPrepare: vi.fn(() => ({ ok: true })) }))
vi.mock("./stages/gate", () => ({ runGate: mocks.gate }))
vi.mock("./stages/execute", () => ({ runExecute: mocks.execute, acceptExecute: vi.fn(() => ({ ok: true })) }))
vi.mock("./stages/audit", () => ({ runAudit: mocks.audit }))
vi.mock("./role-config", () => ({ ROLE_META: {}, recordRoleRun: vi.fn().mockResolvedValue(undefined) }))
vi.mock("./stages/custom", () => ({
  runCustomAgents: vi.fn().mockResolvedValue([]),
  summarizeCustomAgentResults: vi.fn(() => []),
}))
vi.mock("./orchestrator", () => ({
  OrchestratorAgent: class {
    plan = vi.fn().mockResolvedValue("plan")
    beginStage = vi.fn()
    nextAttempt = vi.fn(() => 1)
    emitRetry = vi.fn()
    recordFailure = vi.fn()
    isExhausted = vi.fn(() => false)
    decideOnExhaustion = vi.fn()
    applyFix = vi.fn()
    evaluate = vi.fn().mockResolvedValue({ decision: "proceed", thinking: "ok" })
    ask = vi.fn()
    applyOptionAction = vi.fn()
    complete = vi.fn()
  },
}))

const job = { id: "job_1", company: "Acme", role: "Engineer", description: "TypeScript", updatedAt: new Date() }
const scored = { job, score: 90, matchedKeywords: ["TypeScript"], missingKeywords: [], recommendation: "strong" }

describe("pipeline checkpoint recovery", () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.gate.mockResolvedValue({ data: { approved: [], pending: [], skipped: [] }, metrics: { durationMs: 1, count: 0 } })
    mocks.execute.mockResolvedValue({ data: { queued: [], failed: [] }, metrics: { durationMs: 1, count: 0 } })
    mocks.audit.mockResolvedValue({ data: { warnings: [], report: {} }, metrics: { durationMs: 1, count: 0 } })
    mocks.checkpoint.mockResolvedValue(undefined)
  })

  it("resumes at Gate without repeating discovery, scoring, or material generation", async () => {
    const { runPipeline } = await import("./pipeline")
    const result = await runPipeline({
      userId: "user_1", sessionId: "session_1", agentCfg: { dailyLimit: 5, minMatchScore: 70, autoApply: false, requireApproval: true, targetLocations: [], targetRoles: [], excludeCompanies: [], priorityCompanies: [], autoCoverLetter: false, coverTone: "professional", useTailoredCV: false, model: "test" } as never,
      roleConfigs: {} as never, resumeText: "resume", resumeContent: {} as never, defaultResume: { id: "resume_1", name: "CV", templateId: null, templateOptions: null, directionId: null, basicsDetached: false },
      aiConfig: { provider: "minimax", model: "test", apiKey: "key" }, autonomous: false, emit: vi.fn(), checkpoint: mocks.checkpoint,
      resumeState: { nextStage: "gate", scoutedJobs: [job] as never, scoredJobs: [scored] as never, preparedPackages: [scored] as never, analysisFailed: 0 },
    })

    expect(mocks.scout).not.toHaveBeenCalled()
    expect(mocks.analyze).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.gate).toHaveBeenCalledTimes(1)
    expect(result.processed).toBe(1)
    expect(mocks.checkpoint).toHaveBeenLastCalledWith(expect.objectContaining({ nextStage: "completed" }))
  })
})
