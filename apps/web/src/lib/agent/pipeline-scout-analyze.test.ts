import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '@prisma/client'
import { acceptAnalyze, runAnalyze } from './stages/analyze'
import { acceptScout, runScout } from './stages/scout'
import type { PipelineScoutAnalyzeResult, PipelineStageRuntimeContext } from './pipeline-context'
import type { OrchestratorAgent } from './orchestrator'
import type { PipelineCheckpointState, PipelineCtx, PipelineStage, ScoredJob } from './types'
import { runPrepareGateStages } from './pipeline-prepare-gate'
import { runExecuteAuditStages } from './pipeline-execute-audit'
import { runScoutAnalyzeStages } from './pipeline-scout-analyze'

vi.mock('./stages/scout', () => ({ runScout: vi.fn(), acceptScout: vi.fn(() => ({ ok: true })) }))
vi.mock('./stages/analyze', () => ({ runAnalyze: vi.fn(), acceptAnalyze: vi.fn(() => ({ ok: true })) }))
vi.mock('./pipeline-prepare-gate', () => ({ runPrepareGateStages: vi.fn() }))
vi.mock('./pipeline-execute-audit', () => ({ runExecuteAuditStages: vi.fn() }))
vi.mock('./role-config', () => ({ ROLE_META: {}, recordRoleRun: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./stages/custom', () => ({ runCustomAgents: vi.fn().mockResolvedValue([]) }))
vi.mock('./orchestrator', () => ({
  OrchestratorAgent: class {
    plan = vi.fn().mockResolvedValue(undefined)
    beginStage = vi.fn()
    nextAttempt = vi.fn(() => 1)
    emitRetry = vi.fn()
    recordFailure = vi.fn()
    isExhausted = vi.fn(() => false)
    decideOnExhaustion = vi.fn(async () => 'continue')
    applyFix = vi.fn()
    evaluate = vi.fn(async () => ({ decision: 'continue' }))
    ask = vi.fn(async () => 'continue')
    applyOptionAction = vi.fn()
    complete = vi.fn()
  },
}))

function makeRuntime(startStage: PipelineStage, initial: Partial<PipelineCheckpointState> = {}): PipelineStageRuntimeContext {
  let state: PipelineCheckpointState = { nextStage: startStage, ...initial }
  const emit = vi.fn()
  const orchestrator = {
    beginStage: vi.fn(),
    nextAttempt: vi.fn(() => 1),
    emitRetry: vi.fn(),
    recordFailure: vi.fn(),
    isExhausted: vi.fn(() => false),
    decideOnExhaustion: vi.fn(async () => 'continue'),
    applyFix: vi.fn(),
    evaluate: vi.fn(async () => ({ decision: 'continue' })),
    ask: vi.fn(async () => 'continue'),
    applyOptionAction: vi.fn(),
    complete: vi.fn(),
  } as unknown as OrchestratorAgent
  const persist = vi.fn(async (nextStage: PipelineCheckpointState['nextStage'], patch: Partial<PipelineCheckpointState> = {}) => {
    state = { ...state, ...patch, nextStage }
  })
  const ctx = {
    userId: 'user-1',
    agentCfg: { targetRoles: ['engineer'], excludeCompanies: [], dailyLimit: 5, minMatchScore: 60 } as unknown as PipelineCtx['agentCfg'],
  } as unknown as PipelineCtx
  const order: Record<PipelineStage, number> = { scout: 0, analyze: 1, prepare: 2, gate: 3, execute: 4, audit: 5, completed: 6 }
  return {
    ctx,
    pipelineCtx: { emit } as unknown as PipelineCtx,
    controlledCtx: { emit } as unknown as PipelineCtx,
    orchestrator,
    getState: () => state,
    needsStage: stage => order[state.nextStage] <= order[stage],
    emit,
    emitRole: vi.fn(),
    assertAlive: vi.fn(async () => undefined),
    flushCanonical: vi.fn(async () => undefined),
    persist,
    collectCustomResults: vi.fn(async () => undefined),
    recordRoleRun: vi.fn(async () => undefined),
    getCustomAgentResults: () => [],
    throwInterrupted: () => { throw new Error('unexpected interruption') },
    startedAt: Date.now(),
  }
}

describe('runScoutAnalyzeStages', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does not finish after the scout exhaustion decision loses ownership', async () => {
    const ownerLost = new Error('execution ownership changed')
    const runtime = makeRuntime('scout')
    vi.mocked(runScout).mockResolvedValue({
      stage: 'scout', ok: true, data: { jobs: [], discovered: 0 }, metrics: { durationMs: 8, count: 0 },
    })
    vi.mocked(acceptScout).mockReturnValueOnce({ ok: false, reason: 'scout failed' })
    vi.mocked(runtime.orchestrator.isExhausted).mockReturnValue(true)
    vi.mocked(runtime.orchestrator.decideOnExhaustion).mockResolvedValue('abort')
    vi.mocked(runtime.assertAlive).mockResolvedValueOnce(undefined).mockRejectedValueOnce(ownerLost)

    await expect(runScoutAnalyzeStages(runtime)).rejects.toBe(ownerLost)

    expect(runtime.emit).not.toHaveBeenCalledWith('done', expect.anything())
  })

  it('does not finish after the analyst exhaustion decision loses ownership', async () => {
    const ownerLost = new Error('execution ownership changed')
    const job = { id: 'job-1' } as unknown as Job
    const runtime = makeRuntime('analyze', { scoutedJobs: [job] })
    vi.mocked(runAnalyze).mockResolvedValue({
      stage: 'analyze', ok: true, data: { scoredJobs: [], failed: 1 }, metrics: { durationMs: 9, count: 0 },
    })
    vi.mocked(acceptAnalyze).mockReturnValueOnce({ ok: false, reason: 'analysis failed' })
    vi.mocked(runtime.orchestrator.isExhausted).mockReturnValue(true)
    vi.mocked(runtime.orchestrator.decideOnExhaustion).mockResolvedValue('abort')
    vi.mocked(runtime.assertAlive).mockResolvedValueOnce(undefined).mockRejectedValueOnce(ownerLost)

    await expect(runScoutAnalyzeStages(runtime)).rejects.toBe(ownerLost)

    expect(runtime.emit).not.toHaveBeenCalledWith('done', expect.anything())
  })

  it('returns a terminal report for empty Scout results without entering later stages', async () => {
    vi.mocked(runScout).mockResolvedValue({
      stage: 'scout', ok: true, data: { jobs: [], discovered: 0 }, metrics: { durationMs: 8, count: 0 },
    })
    const emit = vi.fn()
    const ctx = {
      userId: 'user-1',
      agentCfg: { targetRoles: ['engineer'], excludeCompanies: [], dailyLimit: 5, minMatchScore: 60 } as unknown as PipelineCtx['agentCfg'],
      roleConfigs: {} as PipelineCtx['roleConfigs'],
      resumeText: '',
      resumeContent: {} as PipelineCtx['resumeContent'],
      defaultResume: { id: 'resume-1', name: 'Resume', templateId: null, templateOptions: null, directionId: null, basicsDetached: false },
      aiConfig: { provider: 'minimax', model: 'test', apiKey: 'key' } as PipelineCtx['aiConfig'],
      autonomous: false,
      emit,
    } satisfies PipelineCtx
    const { runPipeline } = await import('./pipeline')

    const result = await runPipeline(ctx)

    expect(result).toMatchObject({ processed: 0, applied: 0, queued: 0, pending: 0, skipped: 0, failed: 0 })
    expect(runAnalyze).not.toHaveBeenCalled()
    expect(runPrepareGateStages).not.toHaveBeenCalled()
    expect(runExecuteAuditStages).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith('done', result)
  })

  it('runs Scout then Analyze and checkpoints each existing stage boundary', async () => {
    const job = { id: 'job-1' } as unknown as Job
    const scoredJob = { job, score: 82 } as unknown as ScoredJob
    vi.mocked(runScout).mockResolvedValue({
      stage: 'scout', ok: true, data: { jobs: [job], discovered: 1 }, metrics: { durationMs: 8, count: 1 },
    })
    vi.mocked(runAnalyze).mockResolvedValue({
      stage: 'analyze', ok: true, data: { scoredJobs: [scoredJob], failed: 0 }, metrics: { durationMs: 9, count: 1 },
    })

    const runtime = makeRuntime('scout')
    const result: PipelineScoutAnalyzeResult = await runScoutAnalyzeStages(runtime)

    expect(runScout).toHaveBeenCalledOnce()
    expect(runAnalyze).toHaveBeenCalledOnce()
    expect(vi.mocked(runScout).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(runAnalyze).mock.invocationCallOrder[0])
    expect(vi.mocked(runtime.persist).mock.calls.map(([stage]) => stage)).toEqual(['scout', 'analyze', 'analyze', 'prepare'])
    expect(result).toEqual({ scoutedJobs: [job], scoredJobs: [scoredJob], analysisFailed: 0 })
    expect(vi.mocked(runtime.collectCustomResults).mock.calls.map(([, stage]) => stage)).toEqual(['scout', 'analyst'])
  })
})
