import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '@prisma/client'
import { runGate } from './stages/gate'
import { runPrepare } from './stages/prepare'
import type { PipelinePrepareGateResult, PipelineScoutAnalyzeResult, PipelineStageRuntimeContext } from './pipeline-context'
import type { OrchestratorAgent } from './orchestrator'
import type { ApplicationPackage, GateOutput, PipelineCheckpointState, PipelineCtx, PipelineStage, ScoredJob } from './types'
import { runPrepareGateStages } from './pipeline-prepare-gate'
import { withRunRecorderWriteOwnership } from './session/run-recorder-ownership'

vi.mock('./stages/prepare', () => ({ runPrepare: vi.fn() }))
vi.mock('./stages/gate', () => ({ runGate: vi.fn() }))
vi.mock('./session/run-recorder-ownership', () => ({ withRunRecorderWriteOwnership: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: {} }))

function makeRuntime(startStage: PipelineStage, initial: Partial<PipelineCheckpointState> = {}): PipelineStageRuntimeContext {
  let state: PipelineCheckpointState = { nextStage: startStage, ...initial }
  const emit = vi.fn()
  const orchestrator = {
    beginStage: vi.fn(),
    nextAttempt: vi.fn(() => 1),
    emitRetry: vi.fn(),
    applyFix: vi.fn(),
    ask: vi.fn(async () => 'apply_ai_changes'),
  } as unknown as OrchestratorAgent
  const persist = vi.fn(async (nextStage: PipelineCheckpointState['nextStage'], patch: Partial<PipelineCheckpointState> = {}) => {
    state = { ...state, ...patch, nextStage }
  })
  const ctx = {
    userId: 'user-1',
    agentCfg: {
      targetRoles: ['engineer'], excludeCompanies: [], dailyLimit: 5, minMatchScore: 60,
      autoCoverLetter: false, requireApproval: false, autoApply: false, coverTone: 'professional',
    } as unknown as PipelineCtx['agentCfg'],
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

describe('runPrepareGateStages', () => {
  beforeEach(() => vi.clearAllMocks())

  it('passes prepared packages through Gate and persists Prepare → Gate → Execute in order', async () => {
    const job = { id: 'job-1' } as unknown as Job
    const scoredJob = { job, score: 82 } as unknown as ScoredJob
    const prepared = { ...scoredJob, coverLetter: 'Letter' } as ApplicationPackage
    const gateOutput: GateOutput = { approved: [prepared], pending: [], skipped: [] }
    vi.mocked(runPrepare).mockResolvedValue({
      stage: 'prepare', ok: true, data: { packages: [prepared] }, metrics: { durationMs: 11, count: 1 },
    })
    vi.mocked(runGate).mockResolvedValue({
      stage: 'gate', ok: true, data: gateOutput, metrics: { durationMs: 12, count: 1 },
    })

    const scoutedJobs = [job]
    const input: PipelineScoutAnalyzeResult = { scoutedJobs, scoredJobs: [scoredJob], analysisFailed: 0 }
    const runtime = makeRuntime('prepare', { scoutedJobs, scoredJobs: [scoredJob] })
    const result: PipelinePrepareGateResult = await runPrepareGateStages(runtime, input)

    expect(runPrepare).toHaveBeenCalledOnce()
    expect(runGate).toHaveBeenCalledOnce()
    expect(vi.mocked(runPrepare).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(runGate).mock.invocationCallOrder[0])
    expect(vi.mocked(runtime.persist).mock.calls.map(([stage]) => stage)).toEqual(['prepare', 'gate', 'gate', 'execute'])
    expect(result).toEqual({ preparedPackages: [prepared], gateOutput })
  })

  it.each([
    { answer: 'apply_ai_changes', allowResumeTailoring: true },
    { answer: 'keep_resume', allowResumeTailoring: false },
  ] as const)('passes the resume tailoring choice to Prepare ($answer)', async ({ answer, allowResumeTailoring }) => {
    const job = { id: 'job-1' } as unknown as Job
    const scoredJob = { job, score: 82 } as unknown as ScoredJob
    const prepared = { ...scoredJob } as ApplicationPackage
    vi.mocked(runPrepare).mockResolvedValue({
      stage: 'prepare', ok: true, data: { packages: [prepared] }, metrics: { durationMs: 11, count: 1 },
    })
    vi.mocked(runGate).mockResolvedValue({
      stage: 'gate', ok: true, data: { approved: [], pending: [], skipped: [] }, metrics: { durationMs: 12, count: 0 },
    })

    const runtime = makeRuntime('prepare', { scoutedJobs: [job], scoredJobs: [scoredJob] })
    runtime.ctx = { ...runtime.ctx, agentCfg: { ...runtime.ctx.agentCfg, requireApproval: true } }
    vi.mocked(runtime.orchestrator.ask).mockResolvedValue(answer)

    await runPrepareGateStages(runtime, { scoutedJobs: [job], scoredJobs: [scoredJob], analysisFailed: 0 })

    expect(runtime.orchestrator.ask).toHaveBeenCalledOnce()
    expect(runPrepare).toHaveBeenCalledWith([scoredJob], runtime.controlledCtx, { allowResumeTailoring })
  })

  it('keeps pending-review writes behind the exact execution owner fence', async () => {
    const job = { id: 'job-pending' } as unknown as Job
    const scoredJob = { job, score: 82 } as unknown as ScoredJob
    const prepared = { ...scoredJob } as ApplicationPackage
    vi.mocked(runPrepare).mockResolvedValue({
      stage: 'prepare', ok: true, data: { packages: [prepared] }, metrics: { durationMs: 11, count: 1 },
    })
    vi.mocked(runGate).mockResolvedValue({
      stage: 'gate', ok: true, data: { approved: [], pending: [prepared], skipped: [] }, metrics: { durationMs: 12, count: 1 },
    })
    vi.mocked(withRunRecorderWriteOwnership).mockResolvedValue({ owned: true, value: null })

    const scoutedJobs = [job]
    const input: PipelineScoutAnalyzeResult = { scoutedJobs, scoredJobs: [scoredJob], analysisFailed: 0 }
    const runtime = makeRuntime('prepare', { scoutedJobs, scoredJobs: [scoredJob] })
    runtime.ctx = {
      ...runtime.ctx,
      sessionId: 'session-1', turnId: 'turn-1',
      executionAttempt: { id: 'execution-1', attemptCount: 3 },
    }

    await runPrepareGateStages(runtime, input)

    expect(withRunRecorderWriteOwnership).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: 'session-1', userId: 'user-1',
        owner: { executionAttempt: { id: 'execution-1', attemptCount: 3 }, turnId: 'turn-1', signal: undefined, requireRunning: true },
      }),
      expect.any(Function),
    )
  })

  it('interrupts before pending-job status writes when run ownership identity is missing', async () => {
    const job = { id: 'job-pending' } as unknown as Job
    const scoredJob = { job, score: 82 } as unknown as ScoredJob
    const prepared = { ...scoredJob } as ApplicationPackage
    vi.mocked(runPrepare).mockResolvedValue({
      stage: 'prepare', ok: true, data: { packages: [prepared] }, metrics: { durationMs: 11, count: 1 },
    })
    vi.mocked(runGate).mockResolvedValue({
      stage: 'gate', ok: true, data: { approved: [], pending: [prepared], skipped: [] }, metrics: { durationMs: 12, count: 1 },
    })

    const scoutedJobs = [job]
    const input: PipelineScoutAnalyzeResult = { scoutedJobs, scoredJobs: [scoredJob], analysisFailed: 0 }
    const runtime = makeRuntime('prepare', { scoutedJobs, scoredJobs: [scoredJob] })
    const interrupted = new Error('pipeline interrupted')
    const throwInterrupted = vi.fn((): never => { throw interrupted })
    runtime.throwInterrupted = throwInterrupted

    expect(runtime.ctx).not.toHaveProperty('executionAttempt')
    expect(runtime.ctx).not.toHaveProperty('sessionId')
    expect(runtime.ctx).not.toHaveProperty('turnId')
    await expect(runPrepareGateStages(runtime, input)).rejects.toBe(interrupted)

    expect(throwInterrupted).toHaveBeenCalledOnce()
    expect(withRunRecorderWriteOwnership).not.toHaveBeenCalled()
  })
})
