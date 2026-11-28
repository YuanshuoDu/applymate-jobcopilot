import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import type { ApprovalScopeInput } from './approval/types'
import { createAnalyzeSourceFingerprint, AnalyzeSourceChangedError, readAnalyzeSourceChangedClaims } from './stages/analyze-model-input'
import { acquireScheduledTaskGraphGateSourceFence, assertScheduledTaskGraphGateSourcesCurrent, createScheduledTaskGraphGateOwnerFence,
  isScheduledTaskGraphGateSourceChangedError, isScheduledTaskGraphGateSourceProofInvalidError, scheduledTaskGraphGateReceiptSourceHooks,
  scheduledTaskGraphGateSourceFingerprintProjection } from './scheduled-taskgraph-gate-source'

const mocks = vi.hoisted(() => ({ resume: vi.fn(), job: vi.fn(), execution: vi.fn(), resumeText: vi.fn(), sourceFence: vi.fn() }))
vi.mock('./types', () => ({ resumeToText: mocks.resumeText }))
vi.mock('./source-material-fence', () => ({ acquireSourceMaterialFence: mocks.sourceFence }))

const owner = { userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1', rootAttemptCount: 1,
  turnLeaseOwnerId: 'lease-1', turnLeaseVersion: 1, executionId: 'execution-1', executionAttemptCount: 2 }
const analysisFenceAt = '2026-10-20T09:00:00.000Z'
const job = { company: 'Example', role: 'Engineer', location: 'Dublin', description: 'Build systems', source: 'greenhouse', url: 'https://example.test/job' }
const fingerprint = (jobId = 'job-1', source = job, resumeId = 'resume-1') => createAnalyzeSourceFingerprint({
  userId: owner.userId, jobId, job: source, resumeId, resumeText: 'current resume text',
})
const scoreRow = (jobId = 'job-1', score = 0, userId = owner.userId) => ({ job: { id: jobId, userId }, score, analysisFenceAt })
function checkpoint(rows = [scoreRow()]) {
  return { nextStage: 'gate', scoutedJobs: rows.map(row => row.job), scoredJobs: rows,
    analysisFailed: 0, scheduledTaskGraphAnalyzeSourceFingerprints: Object.fromEntries(rows.map(row => [row.job.id, fingerprint(row.job.id)])) }
}
function emptyCheckpoint() {
  const key = 'scheduled-taskgraph:key', lineage = { ...owner }
  return { nextStage: 'gate', scoutedJobs: [], scoredJobs: [], analysisFailed: 0, scheduledTaskGraphAnalyzeSourceFingerprints: {},
    scheduledTaskGraphClaim: { schemaVersion: 'agent-harness.v2.scheduled-pipeline-claim.v1', key, claimToken: 'claim', owner: lineage,
      claimedAt: '2026-10-20T10:00:00.000Z', leaseExpiresAt: '2099-10-20T10:00:00.000Z' },
    scheduledTaskGraphContinuation: { schemaVersion: 'agent-harness.v2.scheduled-pipeline-continuation.v1', key, owner: lineage,
      snapshotDigest: `sha256:${'a'.repeat(64)}`, graphRevision: 1, evidenceDigest: 'b'.repeat(64) } }
}
const tx = { resume: { findFirst: mocks.resume }, job: { findFirst: mocks.job }, agentExecution: { findFirst: mocks.execution } } as unknown as Prisma.TransactionClient

beforeEach(() => {
  vi.clearAllMocks()
  mocks.resumeText.mockReturnValue('current resume text')
  mocks.sourceFence.mockResolvedValue(undefined)
  mocks.resume.mockResolvedValue({ id: 'resume-1', content: {} })
  mocks.job.mockImplementation(async () => job)
  mocks.execution.mockImplementation(async () => ({ state: checkpoint() }))
})

describe('scheduled TaskGraph Gate source provenance', () => {
  it('acquires the exact same-user source fence before owner revalidation', async () => {
    await acquireScheduledTaskGraphGateSourceFence(tx, owner.userId, owner.userId)
    expect(mocks.sourceFence).toHaveBeenCalledWith(tx, [owner.userId])
    await expect(acquireScheduledTaskGraphGateSourceFence(tx, 'foreign-user', owner.userId)).rejects.toBeInstanceOf(AnalyzeSourceChangedError)
    expect(mocks.sourceFence).toHaveBeenCalledOnce()
  })

  it('provides source hooks bound to the exact owner and Job', async () => {
    const fence = createScheduledTaskGraphGateOwnerFence({ owner, key: 'key', claimToken: 'claim' }, 'gate-1', async () => true)
    await fence.sourceHooks.acquireFence(tx, owner.userId)
    await fence.sourceHooks.validateSource(tx, 'job-1')
    expect(mocks.sourceFence).toHaveBeenCalledOnce()
    expect(mocks.job).toHaveBeenCalledWith({ where: { id: 'job-1', userId: owner.userId }, select: {
      company: true, role: true, location: true, description: true, source: true, url: true,
    } })
    await expect(fence.sourceHooks.acquireFence(tx, 'foreign-user')).rejects.toBeInstanceOf(AnalyzeSourceChangedError)
  })

  it('adapts receipt source validation only for the exact owner Turn and selected Job', async () => {
    const fence = createScheduledTaskGraphGateOwnerFence({ owner, key: 'key', claimToken: 'claim' }, 'gate-1', async () => true)
    const hooks = scheduledTaskGraphGateReceiptSourceHooks(fence)
    const scope: ApprovalScopeInput = { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, jobId: 'job-1',
      toolCallId: 'review-1', action: 'review_application', resourceHash: 'a'.repeat(64), materialHash: 'b'.repeat(64),
      answersHash: 'c'.repeat(64), revision: 1, expiresAt: new Date('2026-10-20T10:00:00.000Z') }
    expect(hooks).not.toBeNull()
    await hooks!.acquireFence(tx, owner.userId)
    await hooks!.validateFinalSource(tx, scope)
    expect(mocks.job).toHaveBeenCalledWith({ where: { id: 'job-1', userId: owner.userId }, select: {
      company: true, role: true, location: true, description: true, source: true, url: true,
    } })
    mocks.job.mockClear()
    await expect(hooks!.validateFinalSource(tx, { ...scope, turnId: 'other-turn' }))
      .rejects.toBeInstanceOf(AnalyzeSourceChangedError)
    expect(mocks.job).not.toHaveBeenCalled()
  })

  it('accepts a legal zero score only with its exact current source fingerprint', async () => {
    const current = checkpoint([scoreRow('job-1', 0)])
    await expect(assertScheduledTaskGraphGateSourcesCurrent(tx, { owner, checkpoint: current })).resolves.toBeUndefined()
    expect(mocks.job).toHaveBeenCalledWith({ where: { id: 'job-1', userId: owner.userId }, select: {
      company: true, role: true, location: true, description: true, source: true, url: true,
    } })
  })

  it('re-reads the live execution checkpoint when validating a final receipt source hook', async () => {
    await expect(assertScheduledTaskGraphGateSourcesCurrent(tx, { owner, jobId: 'job-1' })).resolves.toBeUndefined()
    expect(mocks.execution).toHaveBeenCalledWith({ where: { id: owner.executionId, userId: owner.userId,
      sessionId: owner.sessionId, status: 'running', attemptCount: owner.executionAttemptCount }, select: { state: true } })
  })

  it.each([
    ['a missing map', (value: Record<string, unknown>) => { delete value.scheduledTaskGraphAnalyzeSourceFingerprints }],
    ['a malformed digest', (value: Record<string, unknown>) => { value.scheduledTaskGraphAnalyzeSourceFingerprints = { 'job-1': { version: 'agent-harness.v2.analyze-source-input.v1', digest: 'bad' } } }],
    ['an extra foreign key', (value: Record<string, unknown>) => { value.scheduledTaskGraphAnalyzeSourceFingerprints = { ...value.scheduledTaskGraphAnalyzeSourceFingerprints as object, other: fingerprint('other') } }],
    ['a foreign checkpoint job', (value: Record<string, unknown>) => { value.scoredJobs = [scoreRow('job-1', 0, 'other-user')] }],
    ['a duplicate scored job', (value: Record<string, unknown>) => { value.scoredJobs = [scoreRow(), scoreRow()] }],
  ])('rejects %s before reading current sources', async (_name, mutate) => {
    const value = checkpoint() as Record<string, unknown>
    mutate(value)
    const error = await assertScheduledTaskGraphGateSourcesCurrent(tx, { owner, checkpoint: value }).catch(reason => reason)
    expect(error).toBeInstanceOf(AnalyzeSourceChangedError)
    expect(isScheduledTaskGraphGateSourceChangedError(error)).toBe(false)
    expect(isScheduledTaskGraphGateSourceProofInvalidError(error)).toBe(true)
    expect(readAnalyzeSourceChangedClaims(error)).toBeNull()
    expect(mocks.resume).not.toHaveBeenCalled()
    expect(mocks.job).not.toHaveBeenCalled()
  })

  it('rejects a changed current Job, selected Resume, or a package outside the scored set', async () => {
    mocks.job.mockResolvedValue({ ...job, description: 'changed description' })
    const jobDrift = await assertScheduledTaskGraphGateSourcesCurrent(tx, { owner, checkpoint: checkpoint() }).catch(error => error)
    expect(jobDrift).toBeInstanceOf(AnalyzeSourceChangedError)
    expect(isScheduledTaskGraphGateSourceChangedError(jobDrift)).toBe(true)
    expect(readAnalyzeSourceChangedClaims(jobDrift)).toEqual([{ jobId: 'job-1', analysisFenceAt }])

    mocks.job.mockResolvedValue(job)
    mocks.resume.mockResolvedValue({ id: 'resume-2', content: {} })
    const resumeDrift = await assertScheduledTaskGraphGateSourcesCurrent(tx, { owner, checkpoint: checkpoint() }).catch(error => error)
    expect(isScheduledTaskGraphGateSourceChangedError(resumeDrift)).toBe(true)
    expect(readAnalyzeSourceChangedClaims(resumeDrift)).toEqual([{ jobId: 'job-1', analysisFenceAt }])

    const outsideJob = await assertScheduledTaskGraphGateSourcesCurrent(tx, { owner, checkpoint: checkpoint(), jobId: 'other-job' }).catch(error => error)
    expect(outsideJob).toBeInstanceOf(AnalyzeSourceChangedError)
    expect(isScheduledTaskGraphGateSourceProofInvalidError(outsideJob)).toBe(true)
    expect(readAnalyzeSourceChangedClaims(outsideJob)).toBeNull()
  })

  it('creates bounded unique claims for every scored Job before reporting actual source drift', async () => {
    const rows = [scoreRow('job-a'), scoreRow('job-b', 88)]
    mocks.job.mockImplementation(async ({ where }: { where: { id: string } }) => ({ ...job, description: where.id === 'job-b' ? 'changed' : job.description }))
    const error = await assertScheduledTaskGraphGateSourcesCurrent(tx, { owner, checkpoint: checkpoint(rows) }).catch(reason => reason)
    expect(isScheduledTaskGraphGateSourceChangedError(error)).toBe(true)
    expect(readAnalyzeSourceChangedClaims(error)).toEqual([
      { jobId: 'job-a', analysisFenceAt }, { jobId: 'job-b', analysisFenceAt },
    ])

    const unbounded = checkpoint(Array.from({ length: 129 }, (_, index) => scoreRow(`job-${index}`)))
    mocks.job.mockResolvedValue({ ...job, description: 'changed' })
    const oversized = await assertScheduledTaskGraphGateSourcesCurrent(tx, { owner, checkpoint: unbounded }).catch(reason => reason)
    expect(isScheduledTaskGraphGateSourceProofInvalidError(oversized)).toBe(true)
    expect(readAnalyzeSourceChangedClaims(oversized)).toBeNull()
  })

  it('binds the complete sorted fingerprint map into the Analyze checkpoint digest input', () => {
    const value = checkpoint([scoreRow('job-z', 0), scoreRow('job-a', 10)])
    expect(scheduledTaskGraphGateSourceFingerprintProjection(value)).toEqual([
      ['job-a', 'agent-harness.v2.analyze-source-input.v1', fingerprint('job-a').digest],
      ['job-z', 'agent-harness.v2.analyze-source-input.v1', fingerprint('job-z').digest],
    ])
    const changed = { ...value, scheduledTaskGraphAnalyzeSourceFingerprints: {
      ...value.scheduledTaskGraphAnalyzeSourceFingerprints, 'job-a': { ...fingerprint('job-a'), digest: '0'.repeat(64) },
    } }
    expect(scheduledTaskGraphGateSourceFingerprintProjection(changed)).not.toEqual(scheduledTaskGraphGateSourceFingerprintProjection(value))
  })

  it('uses only a verified empty checkpoint when there are no scored jobs', async () => {
    const empty = emptyCheckpoint()
    await expect(assertScheduledTaskGraphGateSourcesCurrent(tx, { owner, checkpoint: empty })).resolves.toBeUndefined()
    expect(scheduledTaskGraphGateSourceFingerprintProjection(empty)).toEqual([])
    const malformed = { ...empty, scheduledTaskGraphAnalyzeSourceFingerprints: { 'job-1': fingerprint() } }
    await expect(assertScheduledTaskGraphGateSourcesCurrent(tx, { owner, checkpoint: malformed })).rejects.toBeInstanceOf(AnalyzeSourceChangedError)
    expect(scheduledTaskGraphGateSourceFingerprintProjection({ ...empty, scheduledTaskGraphClaim: undefined })).toBeNull()
  })
})
