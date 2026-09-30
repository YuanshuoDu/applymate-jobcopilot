import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PipelineCtx } from "./types"

const mocks = vi.hoisted(() => ({
  scout: vi.fn(), analyze: vi.fn(), prepare: vi.fn(), gate: vi.fn(), execute: vi.fn(), audit: vi.fn(),
  checkpoint: vi.fn(),
  evaluate: vi.fn(), ask: vi.fn(), applyOptionAction: vi.fn(), complete: vi.fn(),
  withRunRecorderWriteOwnership: vi.fn(), jobUpdate: vi.fn(),
}))

vi.mock("@/lib/db", () => ({ db: { job: { update: mocks.jobUpdate } } }))
vi.mock("./session/run-recorder-ownership", () => ({ withRunRecorderWriteOwnership: mocks.withRunRecorderWriteOwnership }))
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
    evaluate = mocks.evaluate
    ask = mocks.ask
    applyOptionAction = mocks.applyOptionAction
    complete = mocks.complete
  },
}))

const job = { id: "job_1", company: "Acme", role: "Engineer", description: "TypeScript", updatedAt: new Date() }
const scored = { job, score: 90, matchedKeywords: ["TypeScript"], missingKeywords: [], recommendation: "strong" }

function pipelineContext(emit: PipelineCtx["emit"], assertExecutionCurrent: NonNullable<PipelineCtx["assertExecutionCurrent"]>): PipelineCtx {
  return {
    userId: "user_1",
    sessionId: "session_1",
    agentCfg: {
      dailyLimit: 5, minMatchScore: 70, autoApply: false, requireApproval: true,
      targetLocations: [], targetRoles: [], excludeCompanies: [], priorityCompanies: [],
      autoCoverLetter: false, coverTone: "professional", useTailoredCV: false, model: "test",
    } as never,
    roleConfigs: {} as never,
    resumeText: "resume",
    resumeContent: {} as never,
    defaultResume: { id: "resume_1", name: "CV", templateId: null, templateOptions: null, directionId: null, basicsDetached: false },
    aiConfig: { provider: "minimax", model: "test", apiKey: "key" },
    autonomous: false,
    emit,
    checkpoint: mocks.checkpoint,
    assertExecutionCurrent,
  }
}

describe("pipeline checkpoint recovery", () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.evaluate.mockResolvedValue({ decision: "proceed", thinking: "ok" })
    mocks.ask.mockResolvedValue("keep_resume")
    mocks.applyOptionAction.mockResolvedValue(undefined)
    mocks.gate.mockResolvedValue({ data: { approved: [], pending: [], skipped: [] }, metrics: { durationMs: 1, count: 0 } })
    mocks.execute.mockResolvedValue({ data: { queued: [], failed: [] }, metrics: { durationMs: 1, count: 0 } })
    mocks.audit.mockResolvedValue({ data: { warnings: [], report: {} }, metrics: { durationMs: 1, count: 0 } })
    mocks.checkpoint.mockResolvedValue(undefined)
    mocks.jobUpdate.mockResolvedValue({ id: "job_1" })
    mocks.withRunRecorderWriteOwnership.mockImplementation(async (_db: unknown, _input: unknown, write: (tx: unknown) => Promise<unknown>) => ({
      owned: true, value: await write({ job: { update: mocks.jobUpdate } }),
    }))
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

  it("maps checkpoints to canonical events and stops before the next stage when interrupted", async () => {
    const { runPipeline, PipelineInterruptedError } = await import("./pipeline")
    const controller = new AbortController()
    const canonicalEvents: Array<{ event: string; index: number }> = []
    mocks.scout.mockImplementation(async () => {
      controller.abort()
      return { data: { jobs: [job], discovered: 1 }, metrics: { durationMs: 1, count: 1 } }
    })

    await expect(runPipeline({
      userId: "user_1", sessionId: "session_1", agentCfg: { dailyLimit: 5, minMatchScore: 70, autoApply: false, requireApproval: true, targetLocations: [], targetRoles: [], excludeCompanies: [], priorityCompanies: [], autoCoverLetter: false, coverTone: "professional", useTailoredCV: false, model: "test" } as never,
      roleConfigs: {} as never, resumeText: "resume", resumeContent: {} as never, defaultResume: { id: "resume_1", name: "CV", templateId: null, templateOptions: null, directionId: null, basicsDetached: false },
      aiConfig: { provider: "minimax", model: "test", apiKey: "key" }, autonomous: true, emit: vi.fn(), checkpoint: mocks.checkpoint, signal: controller.signal,
      onCanonicalEvent: event => { canonicalEvents.push({ event: event.event, index: event.index }) },
    })).rejects.toBeInstanceOf(PipelineInterruptedError)

    expect(mocks.analyze).not.toHaveBeenCalled()
    expect(canonicalEvents.find(event => event.event === "pipeline_checkpoint")).toEqual(expect.objectContaining({ event: "pipeline_checkpoint" }))
    expect(mocks.checkpoint).toHaveBeenCalledWith(expect.objectContaining({ nextStage: "scout", eventIndex: expect.any(Number) }))
  })

  it("stops after analyst evaluation when its execution attempt is no longer current", async () => {
    const { runPipeline, PipelineInterruptedError } = await import("./pipeline")
    let analystEvaluated = false
    const events: Array<{ event: string; data: unknown }> = []
    mocks.scout.mockResolvedValue({ data: { jobs: [job], discovered: 1 }, metrics: { durationMs: 1, count: 1 } })
    mocks.analyze.mockResolvedValue({ data: { scoredJobs: [scored], failed: 0 }, metrics: { durationMs: 1, count: 1 } })
    mocks.evaluate.mockImplementation(async (stage: string) => {
      if (stage === "analyst") analystEvaluated = true
      return { decision: "proceed", thinking: "ok" }
    })

    await expect(runPipeline(pipelineContext(
      (event, data) => { events.push({ event, data }) },
      async () => !analystEvaluated,
    ))).rejects.toBeInstanceOf(PipelineInterruptedError)

    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.checkpoint).not.toHaveBeenCalledWith(expect.objectContaining({ nextStage: "prepare" }))
    expect(events.some(item => item.event === "stage_done" && (item.data as { stage?: string }).stage === "analyze")).toBe(false)
    expect(events.some(item => item.event === "role_done" && (item.data as { role?: string }).role === "analyst")).toBe(false)
    expect(events.some(item => item.event === "agent_reflect" && (item.data as { role?: string }).role === "analyst")).toBe(false)
  })

  it("does not complete or emit done when the attempt is reclaimed during post-run evaluation", async () => {
    const { runPipeline, PipelineInterruptedError } = await import("./pipeline")
    let postRunEvaluated = false
    const events: Array<{ event: string; data: unknown }> = []
    mocks.scout.mockResolvedValue({ data: { jobs: [job], discovered: 1 }, metrics: { durationMs: 1, count: 1 } })
    mocks.analyze.mockResolvedValue({ data: { scoredJobs: [scored], failed: 0 }, metrics: { durationMs: 1, count: 1 } })
    mocks.prepare.mockResolvedValue({ data: { packages: [scored] }, metrics: { durationMs: 1, count: 1 } })
    mocks.evaluate.mockImplementation(async (stage: string) => {
      if (stage === "post-run") postRunEvaluated = true
      return { decision: "proceed", thinking: "ok" }
    })

    await expect(runPipeline(pipelineContext(
      (event, data) => { events.push({ event, data }) },
      async () => !postRunEvaluated,
    ))).rejects.toBeInstanceOf(PipelineInterruptedError)

    expect(mocks.complete).not.toHaveBeenCalled()
    expect(mocks.checkpoint).not.toHaveBeenCalledWith(expect.objectContaining({ nextStage: "completed" }))
    expect(events.some(item => item.event === "done")).toBe(false)
  })

  it("leaves pending Job state unchanged when Stop wins before its readiness projection", async () => {
    const { runPipeline, PipelineInterruptedError } = await import("./pipeline")
    const pendingPackage = { job, score: 90 } as never
    const events: string[] = []
    mocks.gate.mockResolvedValue({ data: { approved: [], pending: [pendingPackage], skipped: [] }, metrics: { durationMs: 1, count: 1 } })
    mocks.withRunRecorderWriteOwnership.mockResolvedValue({ owned: false })
    const context = Object.assign(pipelineContext(event => { events.push(event) }, async () => true), {
      executionAttempt: { id: "execution_1", attemptCount: 4 }, turnId: "turn_1",
      resumeState: { nextStage: "gate", scoutedJobs: [job], scoredJobs: [scored], preparedPackages: [pendingPackage], analysisFailed: 0 },
    })

    await expect(runPipeline(context)).rejects.toBeInstanceOf(PipelineInterruptedError)

    expect(mocks.withRunRecorderWriteOwnership).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sessionId: "session_1", userId: "user_1",
      owner: expect.objectContaining({ turnId: "turn_1", executionAttempt: { id: "execution_1", attemptCount: 4 }, requireRunning: true }),
    }), expect.any(Function))
    expect(mocks.jobUpdate).not.toHaveBeenCalled()
    expect(events).toContain("info")
  })

  it("stops before Analyze when Scout orchestration fails", async () => {
    const { runPipeline } = await import("./pipeline")
    mocks.scout.mockResolvedValue({ data: { jobs: [job], discovered: 1 }, metrics: { durationMs: 1, count: 1 } })
    mocks.evaluate.mockRejectedValue(new Error("orchestrator decision invalid"))

    await expect(runPipeline(pipelineContext(vi.fn(), async () => true)))
      .rejects.toThrow("orchestrator decision invalid")

    expect(mocks.analyze).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
  })
})
