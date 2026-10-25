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

const scheduledOwner = {
  userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-task-1', rootAttemptCount: 1,
  turnLeaseOwnerId: 'lease-owner-1', turnLeaseVersion: 1, executionId: 'execution-1', executionAttemptCount: 0,
}
const scheduledKey = `scheduled-taskgraph:sha256:${'a'.repeat(64)}`
const scheduledClaimToken = 'claim-token-1'

function withScheduledOwnerProof(initial: Partial<PipelineCheckpointState> = {}): Partial<PipelineCheckpointState> {
  return {
    ...initial,
    scheduledTaskGraphContinuation: {
      schemaVersion: 'agent-harness.v2.scheduled-pipeline-continuation.v1', key: scheduledKey,
      owner: scheduledOwner, snapshotDigest: `sha256:${'b'.repeat(64)}`, graphRevision: 2, evidenceDigest: 'c'.repeat(64),
    },
    scheduledTaskGraphClaim: {
      schemaVersion: 'agent-harness.v2.scheduled-pipeline-claim.v1', key: scheduledKey, claimToken: scheduledClaimToken,
      owner: scheduledOwner, claimedAt: '2026-10-25T09:00:00.000Z', leaseExpiresAt: '2026-10-25T10:00:00.000Z',
    },
  } as unknown as Partial<PipelineCheckpointState>
}

function attachScheduledOwnerFence(
  runtime: PipelineStageRuntimeContext,
  owner = scheduledOwner,
): void {
  Object.assign(runtime.ctx, {
    sessionId: owner.sessionId,
    turnId: owner.turnId,
    executionAttempt: { id: owner.executionId, attemptCount: owner.executionAttemptCount },
    scheduledTaskGraphOwnerFence: {
      owner, key: scheduledKey, claimToken: scheduledClaimToken, assertCurrent: vi.fn(async () => true),
    },
  })
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
    expect(runtime.orchestrator.evaluate).toHaveBeenCalledWith('post-run', expect.any(String), expect.any(Object))
  })

  it('skips post-run model decisions only for a validated scheduled TaskGraph owner', async () => {
    const { initial, input } = prepareAuditCase()
    const runtime = makeRuntime(withScheduledOwnerProof(initial))
    attachScheduledOwnerFence(runtime)

    const result = await runExecuteAuditStages(runtime, input)

    expect(result.report).toMatchObject({ processed: 1, applied: 0, queued: 1 })
    expect(runExecute).toHaveBeenCalledOnce()
    expect(runAudit).toHaveBeenCalledOnce()
    expect(runtime.orchestrator.evaluate).not.toHaveBeenCalled()
    expect(runtime.orchestrator.ask).not.toHaveBeenCalled()
    expect(runtime.orchestrator.applyFix).not.toHaveBeenCalled()
    const completeOrder = vi.mocked(runtime.orchestrator.complete).mock.invocationCallOrder[0]!
    const livenessChecksBeforeComplete = vi.mocked(runtime.assertAlive).mock.invocationCallOrder.filter(order => order < completeOrder)
    expect(livenessChecksBeforeComplete.length).toBeGreaterThan(0)
  })

  it('keeps the post-run decision for a mismatched scheduled owner proof', async () => {
    const { initial, input } = prepareAuditCase()
    const runtime = makeRuntime(withScheduledOwnerProof(initial))
    attachScheduledOwnerFence(runtime, { ...scheduledOwner, rootTaskId: 'other-root' })

    await runExecuteAuditStages(runtime, input)

    expect(runtime.orchestrator.evaluate).toHaveBeenCalledOnce()
    expect(runtime.orchestrator.evaluate).toHaveBeenCalledWith('post-run', expect.any(String), expect.any(Object))
  })

  it('returns a saved report without rerunning completed stages', async () => {
    const { initial, input } = prepareAuditCase()
    const savedReport = { processed: 2, applied: 0, queued: 1, pending: 1, skipped: 0, failed: 0, durationMs: 42 }
    const runtime = makeRuntime({
      ...initial,
      nextStage: 'completed',
      report: savedReport,
      executeOutput: { queued: ['job-1'], failed: [] },
    })

    const result = await runExecuteAuditStages(runtime, input)

    expect(result).toEqual({ report: savedReport })
    expect(runExecute).not.toHaveBeenCalled()
    expect(runAudit).not.toHaveBeenCalled()
  })

  it('preserves historical report counts on scheduled owner-bound replay', async () => {
    const { initial, input } = prepareAuditCase()
    const savedReport = { processed: 9, applied: 4, queued: 3, pending: 1, skipped: 2, failed: 1, durationMs: 4_200 }
    const runtime = makeRuntime(withScheduledOwnerProof({
      ...initial, nextStage: 'completed', report: savedReport, executeOutput: { queued: ['job-1'], failed: [] },
    }))
    attachScheduledOwnerFence(runtime)

    const result = await runExecuteAuditStages(runtime, input)

    expect(result).toEqual({ report: savedReport })
    expect(runExecute).not.toHaveBeenCalled()
    expect(runAudit).not.toHaveBeenCalled()
    expect(runtime.orchestrator.complete).not.toHaveBeenCalled()
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
