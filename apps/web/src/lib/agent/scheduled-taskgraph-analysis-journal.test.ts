import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job, Prisma } from '@prisma/client'
import { AgentExecutionCancelledError } from './execution-control'
import { scheduledAutomationSnapshotDigest, scheduledTaskGraphContinuationKey, type ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import { AnalyzeRecoveryPersistenceError, runAnalyze } from './stages/analyze'
import type { AnalyzeOutput, PipelineCheckpointState, PipelineCtx, ScoredJob, StageResult } from './types'
import { createScheduledTaskGraphAuditChildOwnerFence, rebindScheduledTaskGraphAnalysisJournalForLease,
  runScheduledTaskGraphAnalyze, scheduledTaskGraphScoreOwnerIsCurrent } from './scheduled-taskgraph-analysis-journal'

const gateFence = vi.hoisted(() => ({ proof: vi.fn() }))
vi.mock('./stages/analyze', async importOriginal => ({
  ...await importOriginal<typeof import('./stages/analyze')>(), runAnalyze: vi.fn(),
}))
vi.mock('./scheduled-taskgraph-approval-fence', () => ({ hasScheduledTaskGraphGateProof: gateFence.proof }))

const jobAId = `c${'1'.repeat(24)}`
const jobBId = `c${'2'.repeat(24)}`
const owner: ScheduledTaskGraphPipelineOwner = {
  userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1', rootAttemptCount: 3,
  turnLeaseOwnerId: 'lease-owner-1', turnLeaseVersion: 7, executionId: 'execution-1', executionAttemptCount: 5,
}
const claimToken = 'claim-token-1'
const snapshot = {
  schemaVersion: 'agent-harness.v2.scheduled-automation-snapshot.v1', targetRoles: ['Software Engineer'],
  targetLocations: ['Dublin'], minScore: 70, dailyCap: 5, requireApproval: true, autoApply: false,
}
const jobs = [job(jobAId), job(jobBId)]
const attestation = {
  schemaVersion: 'agent-harness.v2.scheduled-pipeline-attestation.v1',
  owner: { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
    rootAttemptCount: owner.rootAttemptCount, turnLeaseOwnerId: owner.turnLeaseOwnerId, turnLeaseVersion: owner.turnLeaseVersion },
  snapshotDigest: scheduledAutomationSnapshotDigest(snapshot), graphRevision: 9,
  scout: { taskId: 'scout-task', attemptCount: 2, status: 'completed', verification: 'passed', resultDigest: 'a'.repeat(64),
    candidateJobIds: jobs.map(row => row.id), discoveryReceipt: { status: 'complete', taskId: 'scout-task', attemptCount: 2,
      completedCalls: 1, candidateCount: jobs.length, providerFailures: 0, materializationFailures: 0, hasMore: false, receiptDigest: 'b'.repeat(64) } },
  analyst: { taskId: 'analyst-task', attemptCount: 1, status: 'completed', verification: 'passed', resultDigest: 'c'.repeat(64),
    dependsOnTaskIds: ['scout-task'], jobIds: jobs.map(row => row.id) },
  evidenceDigest: 'd'.repeat(64),
}
const key = scheduledTaskGraphContinuationKey(owner, attestation)
const ctx = { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
  executionAttempt: { id: owner.executionId, attemptCount: owner.executionAttemptCount } } as PipelineCtx
const scoreA = scored(jobs[0], 82)
const scoreB = scored(jobs[1], 74)
const scoreTransaction = { marker: 'score_transaction' } as never

function job(id: string): Job { return { id, userId: owner.userId } as Job }
function scored(jobRow: Job, score: number): ScoredJob {
  return { job: jobRow, score, matchedKeywords: ['TypeScript'], missingKeywords: ['AWS'],
    recommendation: 'Apply after tailoring.', analysisFenceAt: '2026-10-19T12:00:00.123Z' }
}
function analyzeResult(scoredJobs: ScoredJob[], failed = 0): StageResult<AnalyzeOutput> {
  return { stage: 'analyze', ok: true, data: { scoredJobs, failed }, metrics: { durationMs: 1, count: scoredJobs.length } }
}
function initialState(): PipelineCheckpointState & Record<string, unknown> {
  return { nextStage: 'scout', scheduledTaskGraphClaim: {
    schemaVersion: 'agent-harness.v2.scheduled-pipeline-claim.v1', key, claimToken, owner,
  } }
}
function input(state: unknown, persist: (state: PipelineCheckpointState, expectedState: unknown, tx?: Prisma.TransactionClient) => Promise<void>) {
  return { jobs, ctx, owner, key, claimToken, snapshot, attestation, state, persist }
}
function durableState(state: PipelineCheckpointState): PipelineCheckpointState & Record<string, unknown> {
  return JSON.parse(JSON.stringify(state)) as PipelineCheckpointState & Record<string, unknown>
}

describe('runScheduledTaskGraphAnalyze', () => {
  beforeEach(() => vi.resetAllMocks())

  it('persists each score before Analyze returns and reuses it on restart while scoring only missing jobs', async () => {
    const writes: Array<{ state: PipelineCheckpointState & Record<string, unknown>; expectedState: unknown; tx?: Prisma.TransactionClient }> = []
    const attempted: string[] = []
    vi.mocked(runAnalyze).mockImplementation(async (pending, _ctx, recovery) => {
      const ids = pending.map(row => row.id)
      if (ids.includes(jobAId)) {
        attempted.push(jobAId)
        await recovery?.beforeScore?.(jobAId)
        await recovery?.onScoredJob?.(scoreA, scoreTransaction)
        return analyzeResult([scoreA])
      }
      expect(ids).toEqual([jobBId])
      expect(recovery?.existingScoredJobs).toEqual([scoreA])
      attempted.push(jobBId)
      await recovery?.beforeScore?.(jobBId)
      await recovery?.onScoredJob?.(scoreB, scoreTransaction)
      return analyzeResult([...(recovery?.existingScoredJobs ?? [])])
    })
    const persist = async (state: PipelineCheckpointState, expectedState: unknown, tx?: Prisma.TransactionClient) => {
      writes.push({ state: durableState(state), expectedState, tx })
    }

    const first = await runScheduledTaskGraphAnalyze(input(initialState(), persist))
    const scoredWrite = writes.find(write => write.state.scoredJobs?.length === 1)!
    const journal = scoredWrite.state.scheduledTaskGraphAnalyzeJournal as Record<string, unknown>

    expect(first.analysis.data?.scoredJobs).toEqual([scoreA])
    expect(scoredWrite.state.nextStage).toBe('scout')
    expect(scoredWrite.state.scoredJobs?.[0]).toMatchObject({ job: { id: jobAId }, score: 82, analysisFenceAt: scoreA.analysisFenceAt })
    expect(journal).toMatchObject({ key, owner, attemptsByJob: { [jobAId]: 1 }, failedJobIds: [] })
    expect(scoredWrite.tx).toBe(scoreTransaction)
    expect(scoredWrite.expectedState).toMatchObject({ scoredJobs: [], scheduledTaskGraphAnalyzeJournal: { attemptsByJob: { [jobAId]: 1 } } })
    expect(first.checkpoint).toMatchObject({ nextStage: 'prepare', scoredJobs: [scoreA] })
    expect(first.checkpoint).not.toHaveProperty('scheduledTaskGraphAnalyzeJournal')
    expect(first.persistedState).toMatchObject({ nextStage: 'scout', scoredJobs: [scoreA] })

    const second = await runScheduledTaskGraphAnalyze(input(scoredWrite.state, persist))

    expect(attempted).toEqual([jobAId, jobBId])
    expect(second.analysis.data?.scoredJobs.map(row => row.score)).toEqual([82, 74])
    expect(second.checkpoint.scoredJobs?.map(row => row.score)).toEqual([82, 74])
    expect(vi.mocked(runAnalyze).mock.calls.map(([pending]) => pending.map(row => row.id))).toEqual([[jobAId, jobBId], [jobBId]])
  })

  it('durably records an empty Analyze result and continues zero-job evidence to Prepare', async () => {
    const zeroAttestation = {
      ...attestation,
      scout: { ...attestation.scout, candidateJobIds: [], discoveryReceipt: { ...attestation.scout.discoveryReceipt, candidateCount: 0 } },
      analyst: { ...attestation.analyst, jobIds: [] },
    }
    const zeroKey = scheduledTaskGraphContinuationKey(owner, zeroAttestation)
    const claim = initialState().scheduledTaskGraphClaim as Record<string, unknown>
    const state = { ...initialState(), scheduledTaskGraphClaim: { ...claim, key: zeroKey } }
    const writes: Array<PipelineCheckpointState & Record<string, unknown>> = []
    vi.mocked(runAnalyze).mockImplementation(async pending => {
      expect(pending).toEqual([])
      return analyzeResult([])
    })

    const result = await runScheduledTaskGraphAnalyze({
      ...input(state, async next => { writes.push(durableState(next)) }),
      jobs: [], attestation: zeroAttestation, key: zeroKey,
    })

    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ nextStage: 'scout', scoutedJobs: [], scoredJobs: [], analysisFailed: 0,
      scheduledTaskGraphAnalyzeJournal: { key: zeroKey, owner, attemptsByJob: {}, failedJobIds: [] } })
    expect(result.checkpoint).toMatchObject({ nextStage: 'prepare', scoutedJobs: [], scoredJobs: [], analysisFailed: 0 })
    expect(result.checkpoint).not.toHaveProperty('scheduledTaskGraphAnalyzeJournal')
  })

  it('does not make a third model attempt when the prior return was ambiguous twice', async () => {
    const persisted: Array<PipelineCheckpointState & Record<string, unknown>> = []
    const state = { ...initialState(), scoutedJobs: jobs, scoredJobs: [scoreA], analysisFailed: 0,
      scheduledTaskGraphAnalyzeJournal: { schemaVersion: 'agent-harness.v2.scheduled-taskgraph-analysis-journal.v1', key, owner,
        attemptsByJob: { [jobAId]: 1, [jobBId]: 2 }, failedJobIds: [] } }
    vi.mocked(runAnalyze).mockImplementation(async (pending, _ctx, recovery) => {
      expect(pending.map(row => row.id)).toEqual([jobBId])
      try { await recovery?.beforeScore?.(jobBId) }
      catch {
        await recovery?.onScoreFailure?.(jobBId)
        return analyzeResult([...(recovery?.existingScoredJobs ?? [])], 1)
      }
      throw new Error('retry limit should prevent the model call')
    })

    const result = await runScheduledTaskGraphAnalyze(input(state, async next => { persisted.push(durableState(next)) }))
    const terminal = persisted.at(-1)!
    const journal = terminal.scheduledTaskGraphAnalyzeJournal as Record<string, unknown>

    expect(result.analysis.data).toMatchObject({ failed: 1, scoredJobs: [scoreA] })
    expect(journal).toMatchObject({ attemptsByJob: { [jobBId]: 2 }, failedJobIds: [jobBId] })
    expect(terminal.analysisFailed).toBe(1)
  })

  it('leaves failed score-journal writes ambiguous and permits only the bounded retry', async () => {
    const writes: Array<PipelineCheckpointState & Record<string, unknown>> = []
    const modelStarts: string[] = []
    let failedScoreWrites = 2
    const persist = async (next: PipelineCheckpointState) => {
      const state = durableState(next)
      if (state.scoredJobs?.length === 2 && failedScoreWrites > 0) {
        failedScoreWrites--
        throw new Error('journal storage unavailable')
      }
      writes.push(state)
    }
    const state = { ...initialState(), scoutedJobs: jobs, scoredJobs: [scoreB], analysisFailed: 0,
      scheduledTaskGraphAnalyzeJournal: { schemaVersion: 'agent-harness.v2.scheduled-taskgraph-analysis-journal.v1', key, owner,
        attemptsByJob: { [jobBId]: 1 }, failedJobIds: [] } }
    vi.mocked(runAnalyze).mockImplementation(async (pending, _ctx, recovery) => {
      expect(pending.map(row => row.id)).toEqual([jobAId])
      try {
        await recovery?.beforeScore?.(jobAId)
        modelStarts.push(jobAId)
        await recovery?.onScoredJob?.(scoreA, scoreTransaction)
        return analyzeResult([...(recovery?.existingScoredJobs ?? [])])
      } catch (error) {
        if (error instanceof AnalyzeRecoveryPersistenceError) throw error
        await recovery?.onScoreFailure?.(jobAId)
        return analyzeResult([...(recovery?.existingScoredJobs ?? [])], 1)
      }
    })

    await expect(runScheduledTaskGraphAnalyze(input(state, persist))).rejects.toBeInstanceOf(AnalyzeRecoveryPersistenceError)
    const afterFirst = writes.at(-1)!
    expect(afterFirst.scoredJobs?.map(row => row.job.id)).toEqual([jobBId])
    expect((afterFirst.scheduledTaskGraphAnalyzeJournal as Record<string, unknown>).attemptsByJob).toMatchObject({ [jobAId]: 1 })
    expect((afterFirst.scheduledTaskGraphAnalyzeJournal as Record<string, unknown>).failedJobIds).toEqual([])

    await expect(runScheduledTaskGraphAnalyze(input(afterFirst, persist))).rejects.toBeInstanceOf(AnalyzeRecoveryPersistenceError)
    const afterSecond = writes.at(-1)!
    expect(afterSecond.scoredJobs?.map(row => row.job.id)).toEqual([jobBId])
    expect((afterSecond.scheduledTaskGraphAnalyzeJournal as Record<string, unknown>).attemptsByJob).toMatchObject({ [jobAId]: 2 })
    expect((afterSecond.scheduledTaskGraphAnalyzeJournal as Record<string, unknown>).failedJobIds).toEqual([])

    const recovered = await runScheduledTaskGraphAnalyze(input(afterSecond, persist))
    const terminal = writes.at(-1)!
    const journal = terminal.scheduledTaskGraphAnalyzeJournal as Record<string, unknown>
    expect(modelStarts).toEqual([jobAId, jobAId])
    expect(recovered.analysis.data).toMatchObject({ failed: 1, scoredJobs: [scoreB] })
    expect(journal).toMatchObject({ attemptsByJob: { [jobAId]: 2 }, failedJobIds: [jobAId] })
    expect(terminal.analysisFailed).toBe(1)
  })

  it.each(['executionId', 'executionAttemptCount'] as const)('rejects a durable journal with a mismatched %s', async field => {
    const state = { ...initialState(), scoutedJobs: jobs, scoredJobs: [], analysisFailed: 0,
      scheduledTaskGraphAnalyzeJournal: { schemaVersion: 'agent-harness.v2.scheduled-taskgraph-analysis-journal.v1', key,
        owner: { ...owner, [field]: field === 'executionId' ? 'other-execution' : owner.executionAttemptCount + 1 },
        attemptsByJob: {}, failedJobIds: [] } }

    await expect(runScheduledTaskGraphAnalyze(input(state, vi.fn(async () => undefined))))
      .rejects.toBeInstanceOf(AgentExecutionCancelledError)
    expect(runAnalyze).not.toHaveBeenCalled()
  })

  it('rebinds a valid partial journal across a lease rollover without changing stable execution identity', () => {
    const nextOwner = { ...owner, turnLeaseOwnerId: 'lease-owner-2', turnLeaseVersion: 8 }
    const state = { ...initialState(), scoutedJobs: jobs, scoredJobs: [scoreA], analysisFailed: 0,
      scheduledTaskGraphAnalyzeJournal: { schemaVersion: 'agent-harness.v2.scheduled-taskgraph-analysis-journal.v1', key, owner,
        attemptsByJob: { [jobAId]: 1 }, failedJobIds: [] } }

    const rebound = rebindScheduledTaskGraphAnalysisJournalForLease({ state, owner: nextOwner, key: 'continuation-next' })

    expect(rebound).toMatchObject({ key: 'continuation-next', owner: nextOwner, attemptsByJob: { [jobAId]: 1 }, failedJobIds: [] })
    expect(rebound?.owner).toMatchObject({ userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
      rootTaskId: owner.rootTaskId, rootAttemptCount: owner.rootAttemptCount,
      executionId: owner.executionId, executionAttemptCount: owner.executionAttemptCount })
  })

  it.each(['sessionId', 'turnId', 'rootTaskId', 'rootAttemptCount', 'executionId', 'executionAttemptCount'] as const)(
    'does not rebind an Analyze journal with a different %s', field => {
      const state = { ...initialState(), scoutedJobs: jobs, scoredJobs: [], analysisFailed: 0,
        scheduledTaskGraphAnalyzeJournal: { schemaVersion: 'agent-harness.v2.scheduled-taskgraph-analysis-journal.v1', key, owner,
          attemptsByJob: {}, failedJobIds: [] } }
      const nextOwner = { ...owner, turnLeaseOwnerId: 'lease-owner-2', turnLeaseVersion: 8,
        [field]: field === 'rootAttemptCount' || field === 'executionAttemptCount'
          ? owner[field] + 1 : `other-${field}` } as ScheduledTaskGraphPipelineOwner

      expect(rebindScheduledTaskGraphAnalysisJournalForLease({ state, owner: nextOwner, key: 'continuation-next' })).toBeNull()
    },
  )

  it('locks and checks the Turn, root attempt, and execution claim inside the score transaction', async () => {
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([{ id: owner.turnId }])
      .mockResolvedValueOnce([{ id: owner.turnId, status: 'in_progress' }])
      .mockResolvedValueOnce([{ id: owner.rootTaskId }])
      .mockResolvedValueOnce([{ id: owner.executionId, checkpoint: 'prepare', state: {} }])
    const tx = { $queryRaw: queryRaw } as never

    await expect(scheduledTaskGraphScoreOwnerIsCurrent({ tx, owner, key, claimToken })).resolves.toBe(true)

    expect(queryRaw).toHaveBeenCalledTimes(4)
    const sql = queryRaw.mock.calls.map(([query]) => (query as { sql: string }).sql)
    expect(sql.map(query => query.match(/FROM "([^"]+)"/)?.[1])).toEqual(['agent_turns', 'agent_turns', 'sub_agent_tasks', 'agent_executions'])
    expect(sql[0]).toContain('FOR UPDATE')
    expect(sql[0]).toContain('"rootTaskId" =')
    expect(sql[1]).toContain('"rootTaskId" =')
    expect(sql[1]).toContain('"source"')
    expect(sql[1]).toContain('"executionMode"')
    expect(sql[1]).toContain('"input"')
    expect(sql[2]).toContain('"role" = \'orchestrator\'')
    expect(sql[2]).toContain('"taskType" = \'root\'')
    expect(sql[1]).toContain('clock_timestamp()')
    expect(sql.slice(2).every(query => query.includes('FOR UPDATE'))).toBe(true)
    expect(queryRaw.mock.calls[0]?.[0]).toMatchObject({ values: expect.arrayContaining([owner.rootTaskId]) })
    expect(queryRaw.mock.calls[1]?.[0]).toMatchObject({ values: expect.arrayContaining([owner.rootTaskId]) })
    expect(queryRaw.mock.calls[3]?.[0]).toMatchObject({ values: expect.arrayContaining([key, claimToken, JSON.stringify(owner)]) })
    expect(sql[3]).toContain('jsonb_object_keys')
  })

  it('permits a waiting approval only when the shared Gate proof validates the live scheduled state', async () => {
    const state = { nextStage: 'execute' }, queryRaw = vi.fn()
      .mockResolvedValueOnce([{ id: owner.turnId }])
      .mockResolvedValueOnce([{ id: owner.turnId, status: 'waiting_for_approval', source: 'automation',
        executionMode: 'canonical_task_graph', input: { automationRunMode: 'scheduled' } }])
      .mockResolvedValueOnce([{ id: owner.rootTaskId }])
      .mockResolvedValueOnce([{ id: owner.executionId, checkpoint: 'execute', state }])
    const tx = { $queryRaw: queryRaw } as never
    gateFence.proof.mockResolvedValueOnce(true)

    await expect(scheduledTaskGraphScoreOwnerIsCurrent({ tx, owner, key, claimToken })).resolves.toBe(true)
    expect(gateFence.proof).toHaveBeenCalledWith({ reader: tx, owner, key, claimToken, executionStatus: 'running',
      checkpoint: 'execute', state })
    expect(queryRaw.mock.calls[1]?.[0]).toMatchObject({ values: expect.arrayContaining([owner.turnLeaseOwnerId]) })

    gateFence.proof.mockResolvedValueOnce(false)
    const stale = vi.fn().mockResolvedValueOnce([{ id: owner.turnId }])
      .mockResolvedValueOnce([{ id: owner.turnId, status: 'waiting_for_approval', source: 'automation',
        executionMode: 'canonical_task_graph', input: { automationRunMode: 'scheduled' } }])
      .mockResolvedValueOnce([{ id: owner.rootTaskId }])
      .mockResolvedValueOnce([{ id: owner.executionId, checkpoint: 'gate', state }])
    await expect(scheduledTaskGraphScoreOwnerIsCurrent({ tx: { $queryRaw: stale } as never, owner, key, claimToken })).resolves.toBe(false)
  })

  it.each([
    ['user source', { source: 'user' }],
    ['legacy execution mode', { executionMode: 'legacy_pipeline_adapter' }],
    ['manual automation', { input: { automationRunMode: 'manual' } }],
  ])('rejects a waiting Turn with %s', async (_name, overrides) => {
    const turn = { id: owner.turnId, status: 'waiting_for_approval', source: 'automation',
      executionMode: 'canonical_task_graph', input: { automationRunMode: 'scheduled' }, ...overrides }
    const queryRaw = vi.fn().mockResolvedValueOnce([{ id: owner.turnId }]).mockResolvedValueOnce([turn])
      .mockResolvedValueOnce([{ id: owner.rootTaskId }])
      .mockResolvedValueOnce([{ id: owner.executionId, checkpoint: 'gate', state: {} }])
    await expect(scheduledTaskGraphScoreOwnerIsCurrent({ tx: { $queryRaw: queryRaw } as never, owner, key, claimToken })).resolves.toBe(false)
    expect(gateFence.proof).not.toHaveBeenCalled()
  })

  it('rejects a stale execution claim after locking the still-current Turn and root', async () => {
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([{ id: owner.turnId }])
      .mockResolvedValueOnce([{ id: owner.turnId }])
      .mockResolvedValueOnce([{ id: owner.rootTaskId }])
      .mockResolvedValueOnce([])
    const tx = { $queryRaw: queryRaw } as never

    await expect(scheduledTaskGraphScoreOwnerIsCurrent({ tx, owner, key, claimToken })).resolves.toBe(false)
    expect(queryRaw).toHaveBeenCalledTimes(4)
  })

  it('provides a transaction callback that fences the live Audit actor and its persisted claim', async () => {
    const auditActor = { taskId: 'audit-task', attemptCount: 2, leaseOwner: 'audit-worker-2' }
    const rows: unknown[][] = [
      [{ id: owner.sessionId, status: 'running' }], [],
      [{ id: owner.turnId, userId: owner.userId, sessionId: owner.sessionId, rootTaskId: owner.rootTaskId,
        source: 'automation', executionMode: 'canonical_task_graph', input: { automationRunMode: 'scheduled' }, status: 'waiting_for_dependency',
        leaseOwnerId: null, leaseExpiresAt: null, leaseStartedAt: null, terminalEventSequence: null, terminalEventAt: null }],
      [{ id: owner.rootTaskId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
        parentTaskId: null, status: 'waiting', attemptCount: owner.rootAttemptCount, role: 'orchestrator', taskType: 'root',
        failureReason: null, interruptRequestedAt: null, closedAt: null }],
      [{ id: auditActor.taskId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
        parentTaskId: owner.rootTaskId, depth: 1, role: 'auditor', taskType: 'scheduled_taskgraph_audit', status: 'running',
        attemptCount: auditActor.attemptCount, maxAttempts: 3, leaseOwner: auditActor.leaseOwner, leaseExpiresAt: new Date(),
        interruptRequestedAt: null, closedAt: null, failureReason: null, context: {},
        expectedOutputSchema: { schemaVersion: 'agent-harness.v2.subagent.result', role: 'auditor', taskType: 'scheduled_taskgraph_audit' },
        allowedActions: [], hasLiveLease: true }],
      [{ id: 'dispatch-event' }],
      [{ id: owner.executionId, status: 'running', attemptCount: owner.executionAttemptCount,
        state: initialState() }],
    ]
    const queryRaw = vi.fn(async (_statement: unknown) => rows.shift() ?? [])
    const tx = { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient
    const assertOwnerCurrent = createScheduledTaskGraphAuditChildOwnerFence({ owner, auditActor, key, claimToken })

    await expect(assertOwnerCurrent(tx)).resolves.toBe(true)

    expect(queryRaw).toHaveBeenCalledTimes(7)
    expect(queryRaw.mock.calls.map(([query]) => (query as { sql: string }).sql.match(/FROM "([^"]+)"/)?.[1]))
      .toEqual(['agent_sessions', 'agent_events', 'agent_turns', 'sub_agent_tasks', 'sub_agent_tasks', 'agent_outbox', 'agent_executions'])
  })
})
