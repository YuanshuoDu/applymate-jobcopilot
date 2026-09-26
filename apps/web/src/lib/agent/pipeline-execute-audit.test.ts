import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '@prisma/client'
import { runAudit } from './stages/audit'
import { runExecute } from './stages/execute'
import type { PipelineExecuteAuditInput, PipelineStageRuntimeContext } from './pipeline-context'
import type { OrchestratorAgent } from './orchestrator'
import type { ApplicationPackage, GateOutput, PipelineCheckpointState, PipelineCtx, PipelineStage, ScoredJob } from './types'
import { runExecuteAuditStages } from './pipeline-execute-audit'

vi.mock('./stages/execute', () => ({ runExecute: vi.fn() }))
vi.mock('./stages/audit', () => ({ runAudit: vi.fn() }))
vi.mock('./stages/custom', () => ({ summarizeCustomAgentResults: vi.fn(() => []) }))

function makeRuntime(
  initial: Partial<PipelineCheckpointState> = {},
  beforePersist?: (stage: PipelineCheckpointState['nextStage'], queuedEvents: string[]) => Promise<void> | void,
): PipelineStageRuntimeContext & { queuedEvents: string[] } {
  let state: PipelineCheckpointState = { nextStage: 'execute', ...initial }
  const queuedEvents: string[] = []
  const emit = vi.fn((event: string) => { queuedEvents.push(event) })
  const orchestrator = {
    beginStage: vi.fn(),
    nextAttempt: vi.fn(() => 1),
    emitRetry: vi.fn(),
    recordFailure: vi.fn(),
    evaluate: vi.fn(async () => ({ decision: 'continue' })),
    ask: vi.fn(async () => 'ok'),
    applyOptionAction: vi.fn(),
    applyFix: vi.fn(),
    complete: vi.fn(),
  } as unknown as OrchestratorAgent
  const persist = vi.fn(async (nextStage: PipelineCheckpointState['nextStage'], patch: Partial<PipelineCheckpointState> = {}) => {
    await beforePersist?.(nextStage, queuedEvents)
    state = { ...state, ...patch, nextStage }
  })
  const ctx = {
    userId: 'user-1',
    agentCfg: { minMatchScore: 60, autoApply: false } as unknown as unknown as PipelineCtx['agentCfg'],
  } as unknown as unknown as PipelineCtx
  const order: Record<PipelineStage, number> = { scout: 0, analyze: 1, prepare: 2, gate: 3, execute: 4, audit: 5, completed: 6 }
  return {
    ctx,
    pipelineCtx: { emit } as unknown as unknown as PipelineCtx,
    controlledCtx: { emit } as unknown as unknown as PipelineCtx,
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
    queuedEvents,
  }
}

function prepareAuditCase() {
  const job = { id: 'job-1' } as unknown as Job
  const scoredJob = { job, score: 82 } as unknown as ScoredJob
  const prepared = { ...scoredJob } as ApplicationPackage
  const gateOutput: GateOutput = { approved: [prepared], pending: [], skipped: [] }
  vi.mocked(runExecute).mockResolvedValue({
    stage: 'execute', ok: true, data: { queued: ['job-1'], failed: [] }, metrics: { durationMs: 13, count: 1 },
  })
  vi.mocked(runAudit).mockResolvedValue({
    stage: 'audit', ok: true, data: { report: { processed: 1, applied: 0, queued: 1, pending: 0, skipped: 0, failed: 0, durationMs: 14 }, warnings: [] }, metrics: { durationMs: 14, count: 1 },
  })

  const initial: Partial<PipelineCheckpointState> = {
    scoutedJobs: [job], scoredJobs: [scoredJob], preparedPackages: [prepared], gateOutput,
  }
  const input: PipelineExecuteAuditInput = {
    scoutedJobs: [job], scoredJobs: [scoredJob], analysisFailed: 0,
    preparedPackages: [prepared], gateOutput,
  }
  return { initial, input }
}

describe('runExecuteAuditStages', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does not retry or emit done after ownership is lost during executor backoff', async () => {
    const { initial, input } = prepareAuditCase()
    const ownerLost = new Error('execution ownership changed')
    const runtime = makeRuntime(initial)
    vi.mocked(runtime.orchestrator.nextAttempt).mockReturnValue(2)
    vi.mocked(runtime.assertAlive).mockRejectedValueOnce(ownerLost)

    vi.useFakeTimers()
    try {
      const execution = runExecuteAuditStages(runtime, input)
      const rejected = expect(execution).rejects.toBe(ownerLost)
      await vi.advanceTimersByTimeAsync(2_000)
      await rejected
    } finally {
      vi.useRealTimers()
    }

    expect(runExecute).not.toHaveBeenCalled()
    expect(runtime.orchestrator.emitRetry).not.toHaveBeenCalled()
    expect(runtime.emit).not.toHaveBeenCalledWith('done', expect.anything())
  })

  it('runs Execute then Audit and queues done before the completed checkpoint', async () => {
    const { initial, input } = prepareAuditCase()
    const eventsAtCompletedCheckpoint: string[] = []
    const runtime = makeRuntime(initial, (stage, queuedEvents) => {
      if (stage === 'completed') eventsAtCompletedCheckpoint.push(...queuedEvents)
    })
    const result = await runExecuteAuditStages(runtime, input)

    expect(runExecute).toHaveBeenCalledOnce()
    expect(runAudit).toHaveBeenCalledOnce()
    expect(vi.mocked(runExecute).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(runAudit).mock.invocationCallOrder[0])
    expect(vi.mocked(runtime.persist).mock.calls.map(([stage]) => stage)).toEqual(['execute', 'audit', 'audit', 'completed'])
    expect(runtime.persist).toHaveBeenLastCalledWith('completed', expect.objectContaining({ report: result.report }))
    expect(eventsAtCompletedCheckpoint).toContain('done')
    const doneEventIndex = vi.mocked(runtime.emit).mock.calls.findIndex(([event]) => event === 'done')
    const completedCheckpointIndex = vi.mocked(runtime.persist).mock.calls.findIndex(([stage]) => stage === 'completed')
    expect(vi.mocked(runtime.emit).mock.invocationCallOrder[doneEventIndex]).toBeLessThan(vi.mocked(runtime.persist).mock.invocationCallOrder[completedCheckpointIndex])
    expect(result.report).toMatchObject({ processed: 1, queued: 1, failed: 0 })
  })

  it('does not advance the completed checkpoint when persistence fails after done is queued', async () => {
    const { initial, input } = prepareAuditCase()
    const checkpointError = new Error('completed checkpoint failed')
    const eventsAtCompletedCheckpoint: string[] = []
    const runtime = makeRuntime(initial, (stage, queuedEvents) => {
      if (stage === 'completed') {
        eventsAtCompletedCheckpoint.push(...queuedEvents)
        throw checkpointError
      }
    })

    await expect(runExecuteAuditStages(runtime, input)).rejects.toBe(checkpointError)

    expect(eventsAtCompletedCheckpoint).toContain('done')
    expect(runtime.getState().nextStage).toBe('audit')
    expect(vi.mocked(runtime.emit).mock.calls.some(([event]) => event === 'done')).toBe(true)
  })
})
