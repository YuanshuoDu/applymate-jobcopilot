import { describe, expect, it, vi } from 'vitest'
import type { ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import { createScheduledTaskGraphGateMaterialDriftError, createScheduledTaskGraphGateMaterialDriftEvidence,
  readScheduledTaskGraphGateMaterialDriftProof, scheduledTaskGraphGateMaterialDriftProofMatches,
  buildScheduledTaskGraphGateMaterialDriftTerminalState, isScheduledTaskGraphGateMaterialDriftTerminal,
  scheduledTaskGraphGateMaterialDriftTerminalForRequest } from './scheduled-taskgraph-gate-material-drift'

const mocks = vi.hoisted(() => ({ findExecution: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { agentExecution: { findFirst: mocks.findExecution } } }))

const owner: ScheduledTaskGraphPipelineOwner = { userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1',
  rootAttemptCount: 2, turnLeaseOwnerId: 'turn-lease-1', turnLeaseVersion: 4, executionId: 'execution-1', executionAttemptCount: 7 }
const gate = { taskId: 'gate-1', leaseOwnerId: 'gate-lease-1', attemptCount: 3 }
const digest = (char: string) => `sha256:${char.repeat(64)}`
const row = (overrides: Record<string, unknown> = {}) => ({ jobId: 'job-1', kind: 'resume', taskId: 'prepare-1',
  artifactRef: { artifactId: 'artifact-1', version: 2, contentHash: digest('a'), sourceDigest: digest('b') },
  toolCallId: 'call-1', requestHash: digest('c'), baseId: 'base-1', baseHash: digest('d'), constraintHash: digest('e'),
  provenanceRefs: ['job:job-1', 'resume:resume-1'], evidenceRefs: ['job:job-1', 'resume:resume-1'],
  currentSourceDigest: digest('f'), ...overrides })
const checkpoint = { scoredJobs: [{ job: { id: 'job-1', userId: owner.userId }, score: 80 }],
  scheduledTaskGraphAnalyzeSourceFingerprints: { 'job-1': { version: 'agent-harness.v2.analyze-source-input.v1', digest: '1'.repeat(64) } } }
function errorFor(currentOwner = owner, currentGate = gate) {
  const evidence = createScheduledTaskGraphGateMaterialDriftEvidence([row()])
  if (!evidence) throw new Error('test evidence rejected')
  return createScheduledTaskGraphGateMaterialDriftError({ owner: currentOwner, gate: currentGate,
    snapshotDigest: digest('2'), analyzeCheckpoint: checkpoint, prepareProof: { taskId: 'prepare-1', digest: digest('3') }, evidence })
}
function expectedState() {
  return { scheduledTaskGraphClaim: { schemaVersion: 'agent-harness.v2.scheduled-pipeline-claim.v1',
    key: 'scheduled-taskgraph:key-1', claimToken: 'claim-1', owner, claimedAt: '2026-11-17T10:00:00.000Z',
    leaseExpiresAt: '2026-11-17T10:10:00.000Z' },
    scoredJobs: [{ job: { id: 'job-1', userId: owner.userId }, score: 80, analysisFenceAt: '2026-11-17T10:00:00.000Z' }],
    scheduledTaskGraphContinuation: { key: 'scheduled-taskgraph:key-1', evidenceDigest: digest('9') } }
}

describe('scheduled Gate Prepare material drift proof', () => {
  it('hashes the complete immutable material set and current digest independent of row order', () => {
    const other = row({ jobId: 'job-2', kind: 'cover_letter', taskId: 'prepare-1',
      artifactRef: { artifactId: 'artifact-2', version: 1, contentHash: digest('4'), sourceDigest: digest('5') },
      provenanceRefs: ['job:job-2', 'resume:resume-1'], evidenceRefs: ['job:job-2', 'resume:resume-1'] })
    expect(createScheduledTaskGraphGateMaterialDriftEvidence([row(), other]))
      .toEqual(createScheduledTaskGraphGateMaterialDriftEvidence([other, row()]))
    expect(createScheduledTaskGraphGateMaterialDriftEvidence([row(), row()])).toBeNull()
    expect(createScheduledTaskGraphGateMaterialDriftEvidence([row({ currentSourceDigest: digest('b') })])).toBeNull()
    expect(createScheduledTaskGraphGateMaterialDriftEvidence([row({ requestHash: 'bad' })])).toBeNull()
  })

  it('brands only server-created errors and binds owner lease, Gate child, Analyze map, Prepare proof and artifact digest', () => {
    const error = errorFor()
    const proof = readScheduledTaskGraphGateMaterialDriftProof(error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('scheduled_prepare_material_source_changed')
    expect(readScheduledTaskGraphGateMaterialDriftProof(new Error('scheduled_prepare_material_source_changed'))).toBeNull()
    expect(proof).toMatchObject({ owner, gate, artifactDigest: expect.stringMatching(/^sha256:/),
      currentMaterialDigest: expect.stringMatching(/^sha256:/), analyzeFingerprintDigest: expect.stringMatching(/^sha256:/) })
    expect(scheduledTaskGraphGateMaterialDriftProofMatches(proof!, readScheduledTaskGraphGateMaterialDriftProof(errorFor())!)).toBe(true)
    expect(scheduledTaskGraphGateMaterialDriftProofMatches(proof!, readScheduledTaskGraphGateMaterialDriftProof(
      errorFor({ ...owner, turnLeaseVersion: owner.turnLeaseVersion + 1 }))!)).toBe(false)
    expect(scheduledTaskGraphGateMaterialDriftProofMatches(proof!, readScheduledTaskGraphGateMaterialDriftProof(
      errorFor(owner, { ...gate, attemptCount: gate.attemptCount + 1 }))!)).toBe(false)
  })

  it('builds an independent private marker bound to owner, Gate lease and artifact digest', () => {
    const proof = readScheduledTaskGraphGateMaterialDriftProof(errorFor())!
    const state = buildScheduledTaskGraphGateMaterialDriftTerminalState({ owner, gate, snapshotDigest: digest('2'),
      expectedState: expectedState(), proof })
    expect(state).toMatchObject({ scheduledTaskGraphMaterialDriftTerminal: {
      reason: 'scheduled_prepare_material_source_changed', owner, gate, artifactDigest: proof.artifactDigest,
      analyzeFingerprintDigest: proof.analyzeFingerprintDigest, prepareProofDigest: proof.prepareProofDigest,
      currentMaterialDigest: proof.currentMaterialDigest, proofDigest: proof.proofDigest,
    } })
    expect(state?.scoredJobs).toEqual(expectedState().scoredJobs)
    expect(state?.scheduledTaskGraphContinuation).toEqual(expectedState().scheduledTaskGraphContinuation)
    expect(state?.scheduledTaskGraphClaim).toEqual(expectedState().scheduledTaskGraphClaim)
    expect(state?.scheduledTaskGraphSourceChangeTerminal).toBeUndefined()
    expect(isScheduledTaskGraphGateMaterialDriftTerminal({ owner, gate, status: 'failed',
      error: 'scheduled_prepare_material_source_changed', state })).toBe(true)
    expect(isScheduledTaskGraphGateMaterialDriftTerminal({ owner, gate: { ...gate, leaseOwnerId: 'replaced' }, status: 'failed',
      error: 'scheduled_pipeline_source_changed', state })).toBe(false)
    expect(isScheduledTaskGraphGateMaterialDriftTerminal({ owner, gate, status: 'failed',
      error: 'other', state })).toBe(false)
  })

  it('reads back only a persisted marker matching the exact Gate request scope', async () => {
    const proof = readScheduledTaskGraphGateMaterialDriftProof(errorFor())!
    const state = buildScheduledTaskGraphGateMaterialDriftTerminalState({ owner, gate, snapshotDigest: digest('2'),
      expectedState: expectedState(), proof })
    mocks.findExecution.mockResolvedValue({ id: owner.executionId, status: 'failed', attemptCount: owner.executionAttemptCount,
      error: 'scheduled_prepare_material_source_changed', state })
    const request = { owner, gateTaskId: gate.taskId, gateLeaseOwnerId: gate.leaseOwnerId, gateAttemptCount: gate.attemptCount }
    await expect(scheduledTaskGraphGateMaterialDriftTerminalForRequest(request)).resolves.toBe(true)
    expect(mocks.findExecution).toHaveBeenCalledWith({ where: { userId: owner.userId, sessionId: owner.sessionId },
      select: { id: true, status: true, attemptCount: true, error: true, state: true } })
    await expect(scheduledTaskGraphGateMaterialDriftTerminalForRequest({ ...request, gateLeaseOwnerId: 'replaced' })).resolves.toBe(false)
  })
})
