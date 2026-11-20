import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job, Prisma } from '@prisma/client'
import { AgentExecutionCancelledError } from './execution-control'
import { scheduledAutomationSnapshotDigest, scheduledTaskGraphContinuationKey, type ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import { runAnalyze } from './stages/analyze'
import type { AnalyzeSourceFingerprint } from './stages/analyze-model-input'
import type { AnalyzeOutput, PipelineCheckpointState, PipelineCtx, ScoredJob, StageResult } from './types'
import { rebindScheduledTaskGraphAnalysisJournalForLease, runScheduledTaskGraphAnalyze } from './scheduled-taskgraph-analysis-journal'

vi.mock('./stages/analyze', async importOriginal => ({
  ...await importOriginal<typeof import('./stages/analyze')>(), runAnalyze: vi.fn(),
}))
vi.mock('./scheduled-taskgraph-approval-fence', () => ({ hasScheduledTaskGraphGateProof: vi.fn(async () => true) }))

const jobId = `c${'1'.repeat(24)}`
const owner: ScheduledTaskGraphPipelineOwner = {
  userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1', rootAttemptCount: 3,
  turnLeaseOwnerId: 'lease-owner-1', turnLeaseVersion: 7, executionId: 'execution-1', executionAttemptCount: 5,
}
const claimToken = 'claim-token-1'
const snapshot = {
  schemaVersion: 'agent-harness.v2.scheduled-automation-snapshot.v1', targetRoles: ['Software Engineer'],
  targetLocations: ['Dublin'], minScore: 70, dailyCap: 5, requireApproval: true, autoApply: false,
}
const jobRow = job(jobId)
const jobs = [jobRow]
const attestation = {
  schemaVersion: 'agent-harness.v2.scheduled-pipeline-attestation.v1',
  owner: { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
    rootAttemptCount: owner.rootAttemptCount, turnLeaseOwnerId: owner.turnLeaseOwnerId, turnLeaseVersion: owner.turnLeaseVersion },
  snapshotDigest: scheduledAutomationSnapshotDigest(snapshot), graphRevision: 9,
  scout: { taskId: 'scout-task', attemptCount: 2, status: 'completed', verification: 'passed', resultDigest: 'a'.repeat(64),
    candidateJobIds: [jobId], discoveryReceipt: { status: 'complete', taskId: 'scout-task', attemptCount: 2,
      completedCalls: 1, candidateCount: 1, providerFailures: 0, materializationFailures: 0, hasMore: false, receiptDigest: 'b'.repeat(64) } },
  analyst: { taskId: 'analyst-task', attemptCount: 1, status: 'completed', verification: 'passed', resultDigest: 'c'.repeat(64),
    dependsOnTaskIds: ['scout-task'], jobIds: [jobId] }, evidenceDigest: 'd'.repeat(64),
}
const key = scheduledTaskGraphContinuationKey(owner, attestation)
const ctx = { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
  executionAttempt: { id: owner.executionId, attemptCount: owner.executionAttemptCount } } as PipelineCtx
const scoreA = scored(jobRow, 82)
const fingerprintA: AnalyzeSourceFingerprint = { version: 'agent-harness.v2.analyze-source-input.v1', digest: 'e'.repeat(64) }
const scoreTransaction = { marker: 'score_transaction' } as never

function job(id: string): Job { return { id, userId: owner.userId } as Job }
function scored(job: Job, score: number): ScoredJob {
  return { job, score, matchedKeywords: ['TypeScript'], missingKeywords: ['AWS'],
    recommendation: 'Apply after tailoring.', analysisFenceAt: '2026-10-19T12:00:00.123Z' }
}
function analyzeResult(scoredJobs: ScoredJob[]): StageResult<AnalyzeOutput> {
  return { stage: 'analyze', ok: true, data: { scoredJobs, failed: 0 }, metrics: { durationMs: 1, count: scoredJobs.length } }
}
function initialState(): PipelineCheckpointState & Record<string, unknown> {
  return { nextStage: 'scout', scheduledTaskGraphClaim: {
    schemaVersion: 'agent-harness.v2.scheduled-pipeline-claim.v1', key, claimToken, owner,
  } }
}
function journalState(input: {
  schemaVersion?: string; sourceFingerprintsByJob?: unknown; includeFingerprints?: boolean
} = {}): PipelineCheckpointState & Record<string, unknown> {
  const journal: Record<string, unknown> = {
    schemaVersion: input.schemaVersion ?? 'agent-harness.v2.scheduled-taskgraph-analysis-journal.v2',
    key, owner, attemptsByJob: { [jobId]: 1 }, failedJobIds: [],
  }
  if (input.includeFingerprints !== false) journal.sourceFingerprintsByJob = input.sourceFingerprintsByJob ?? { [jobId]: fingerprintA }
  return { ...initialState(), nextStage: 'scout', scoutedJobs: jobs, scoredJobs: [scoreA], analysisFailed: 0,
    scheduledTaskGraphAnalyzeJournal: journal }
}
function makeInput(state: unknown, persist: (state: PipelineCheckpointState, expected: unknown, tx?: Prisma.TransactionClient) => Promise<void>) {
  return { jobs, ctx, owner, key, claimToken, snapshot, attestation, state, persist }
}
function cloneState(state: PipelineCheckpointState): PipelineCheckpointState & Record<string, unknown> {
  return JSON.parse(JSON.stringify(state)) as PipelineCheckpointState & Record<string, unknown>
}

describe('scheduled Analyze journal source provenance', () => {
  beforeEach(() => vi.resetAllMocks())

  it('persists each fingerprint atomically with its score and carries the exact map into the completed checkpoint', async () => {
    const writes: Array<{ state: PipelineCheckpointState & Record<string, unknown>; tx?: Prisma.TransactionClient }> = []
    vi.mocked(runAnalyze).mockImplementation(async (_pending, _ctx, recovery) => {
      expect(recovery?.sourceFingerprintsByJob).toEqual({})
      await recovery?.beforeScore?.(jobId)
      await recovery?.onScoredJob?.(scoreA, scoreTransaction, fingerprintA)
      return analyzeResult([scoreA])
    })

    const result = await runScheduledTaskGraphAnalyze(makeInput(initialState(), async (next, _expected, tx) => {
      writes.push({ state: cloneState(next), tx })
    }))

    const scoredWrite = writes.find(write => write.state.scoredJobs?.length === 1)!
    const journal = scoredWrite.state.scheduledTaskGraphAnalyzeJournal as Record<string, unknown>
    expect(journal).toMatchObject({ schemaVersion: 'agent-harness.v2.scheduled-taskgraph-analysis-journal.v2',
      sourceFingerprintsByJob: { [jobId]: fingerprintA } })
    expect(scoredWrite.state.scoredJobs?.[0]).toMatchObject({ job: { id: jobId }, score: 82 })
    expect(scoredWrite.tx).toBe(scoreTransaction)
    expect(result.checkpoint).toMatchObject({ scheduledTaskGraphAnalyzeSourceFingerprints: { [jobId]: fingerprintA } })
    expect(result.checkpoint).not.toHaveProperty('scheduledTaskGraphAnalyzeJournal')
  })

  it('passes the persisted map to Analyze before reusing a scored row', async () => {
    vi.mocked(runAnalyze).mockImplementation(async (pending, _ctx, recovery) => {
      expect(pending).toEqual([])
      expect(recovery?.existingScoredJobs).toEqual([scoreA])
      expect(recovery?.sourceFingerprintsByJob).toEqual({ [jobId]: fingerprintA })
      return analyzeResult([scoreA])
    })

    const result = await runScheduledTaskGraphAnalyze(makeInput(journalState(), vi.fn(async () => undefined)))

    expect(runAnalyze).toHaveBeenCalledOnce()
    expect(result.checkpoint).toMatchObject({ scheduledTaskGraphAnalyzeSourceFingerprints: { [jobId]: fingerprintA } })
  })

  it.each([
    ['legacy schema', { schemaVersion: 'agent-harness.v2.scheduled-taskgraph-analysis-journal.v1' }],
    ['missing map', { includeFingerprints: false }],
    ['missing scored ID', { sourceFingerprintsByJob: {} }],
    ['extra ID', { sourceFingerprintsByJob: { [jobId]: fingerprintA, other: fingerprintA } }],
    ['invalid digest', { sourceFingerprintsByJob: { [jobId]: { ...fingerprintA, digest: 'not-a-digest' } } }],
  ] as const)('rejects %s before Analyze can consume persisted scores', async (_name, options) => {
    await expect(runScheduledTaskGraphAnalyze(makeInput(journalState(options), vi.fn(async () => undefined))))
      .rejects.toBeInstanceOf(AgentExecutionCancelledError)
    expect(runAnalyze).not.toHaveBeenCalled()
  })

  it('preserves v2 provenance across a valid lease rebind and rejects legacy provenance', () => {
    const nextOwner = { ...owner, turnLeaseOwnerId: 'lease-owner-2', turnLeaseVersion: 8 }
    const rebound = rebindScheduledTaskGraphAnalysisJournalForLease({ state: journalState(), owner: nextOwner, key: 'continuation-next' })

    expect(rebound).toMatchObject({ key: 'continuation-next', owner: nextOwner, sourceFingerprintsByJob: { [jobId]: fingerprintA } })
    expect(rebindScheduledTaskGraphAnalysisJournalForLease({
      state: journalState({ schemaVersion: 'agent-harness.v2.scheduled-taskgraph-analysis-journal.v1' }), owner: nextOwner, key: 'continuation-next',
    })).toBeNull()
  })
})
