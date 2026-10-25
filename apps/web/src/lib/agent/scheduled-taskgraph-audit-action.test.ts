import { beforeEach, describe, expect, it, vi } from 'vitest'

const { db, childCurrent, lockChild, ownerFence, rootOwnerFence, auditOwnerCurrent, rootOwnerCurrent, auditProof, rootProof, auditGateInput, rootGateInput } = vi.hoisted(() => ({
  db: { $transaction: vi.fn(), agentExecution: { updateMany: vi.fn() } },
  childCurrent: vi.fn(), lockChild: vi.fn(), ownerFence: vi.fn(), rootOwnerFence: vi.fn(), auditOwnerCurrent: vi.fn(), rootOwnerCurrent: vi.fn(),
  auditProof: vi.fn(), rootProof: vi.fn(), auditGateInput: vi.fn(), rootGateInput: vi.fn(),
}))
vi.mock('@/lib/db', () => ({ db }))
vi.mock('./scheduled-taskgraph-audit-child-fence', () => ({ scheduledTaskGraphAuditChildFenceIsCurrent: childCurrent,
  lockScheduledTaskGraphAuditChildFence: lockChild }))
vi.mock('./scheduled-taskgraph-analysis-journal', () => ({ createScheduledTaskGraphAuditChildOwnerFence: ownerFence,
  createScheduledTaskGraphOwnerFence: rootOwnerFence, isScheduledTaskGraphAuditChildOwnerCurrent: auditOwnerCurrent }))
vi.mock('./scheduled-taskgraph-pipeline-fence', () => ({ isScheduledTaskGraphOwnerCurrent: rootOwnerCurrent }))
vi.mock('./scheduled-taskgraph-gate-input', () => ({ isScheduledTaskGraphAuditChildGateProofCurrent: auditProof,
  isScheduledTaskGraphGateProofCurrent: rootProof, loadScheduledTaskGraphAuditChildGateInput: auditGateInput,
  loadScheduledTaskGraphGateInput: rootGateInput }))

import { claimScheduledAuditExecution, lockScheduledAuditContinuation, scheduledAuditChildIsCurrent, scheduledRootIdentityMatches,
  scheduledRootIsCurrent, scheduledTurnLeaseIsCurrent, createScheduledTaskGraphContinuationFence,
  scheduledAuditClaimRaceResponse, scheduledTaskGraphContinuationOwnerIsCurrent, scheduledTaskGraphRunOwnerFence,
  scheduledTaskGraphRunCheckpointIsCurrent, scheduledTaskGraphGateResumeOwnerIsCurrent,
  loadScheduledTaskGraphResumeGateInput, scheduledTaskGraphRunInput } from './scheduled-taskgraph-audit-action'

const owner = { userId: 'user', sessionId: 'session', turnId: 'turn', rootTaskId: 'root', rootAttemptCount: 1,
  turnLeaseOwnerId: 'old-root-owner', turnLeaseVersion: 2, executionId: 'execution', executionAttemptCount: 3 }
const auditActor = { taskId: 'audit', attemptCount: 2, leaseOwner: 'audit-worker' }
const tx = { agentExecution: { updateMany: db.agentExecution.updateMany } }

beforeEach(() => {
  vi.clearAllMocks()
  db.$transaction.mockImplementation(async (operation: (value: typeof tx) => unknown) => operation(tx))
  childCurrent.mockResolvedValue(true)
  lockChild.mockResolvedValue({ taskId: 'audit' })
  ownerFence.mockReturnValue(vi.fn().mockResolvedValue(true))
  rootOwnerFence.mockReturnValue(vi.fn().mockResolvedValue(true))
  auditOwnerCurrent.mockResolvedValue(true)
  rootOwnerCurrent.mockResolvedValue(true)
  auditProof.mockResolvedValue(true)
  rootProof.mockResolvedValue(true)
  auditGateInput.mockResolvedValue({ packages: [], materials: [] })
  rootGateInput.mockResolvedValue({ packages: [], materials: [] })
  db.agentExecution.updateMany.mockResolvedValue({ count: 1 })
})

describe('scheduled Audit action fence adapter', () => {
  it('constructs a strict root or Audit run input from the explicit mode', () => {
    const base = { owner, snapshot: {}, attestation: {}, continuationKey: 'key', claimToken: 'claim', ownedJobs: [], prepareProof: {} }
    expect(scheduledTaskGraphRunInput(base, { kind: 'root' })).toEqual(base)
    expect(scheduledTaskGraphRunInput(base, { kind: 'audit', auditActor })).toEqual({
      ...base, action: 'scheduled_audit_execute', auditActor,
    })
  })

  it('routes only the explicit audit mode through child ownership', async () => {
    const audit = { mode: 'audit' as const, owner, auditActor, key: 'key', claimToken: 'claim' }
    const root = { mode: 'root' as const, owner, key: 'key', claimToken: 'claim' }
    createScheduledTaskGraphContinuationFence(audit)
    expect(ownerFence).toHaveBeenCalledWith({ owner, auditActor, key: 'key', claimToken: 'claim' })
    createScheduledTaskGraphContinuationFence(root)
    expect(rootOwnerFence).toHaveBeenCalledWith({ owner, key: 'key', claimToken: 'claim' })
    await expect(scheduledTaskGraphContinuationOwnerIsCurrent(audit)).resolves.toBe(true)
    expect(auditOwnerCurrent).toHaveBeenCalledWith({ owner, auditActor, key: 'key', claimToken: 'claim' })
  })

  it('selects the matching continuation fence and Gate proof for each action', async () => {
    const audit = { action: 'scheduled_audit_execute' as const, owner, auditActor, key: 'key', claimToken: 'claim',
      snapshot: {}, attestation: {}, continuationKey: 'key', ownedJobs: [] }
    const root = { action: 'execute' as const, owner, key: 'key', claimToken: 'claim', snapshot: {}, attestation: {},
      continuationKey: 'key', ownedJobs: [] }
    const auditOwner = scheduledTaskGraphRunOwnerFence(audit), rootOwner = scheduledTaskGraphRunOwnerFence(root)
    expect(await scheduledTaskGraphRunCheckpointIsCurrent({ scheduled: audit, proofInput: {} as never, tx: tx as never,
      assertOwnerCurrent: vi.fn().mockResolvedValue(true) })).toBe(true)
    expect(auditProof).toHaveBeenCalledWith({ auditActor }, tx)
    expect(await scheduledTaskGraphRunCheckpointIsCurrent({ scheduled: root, proofInput: {} as never, tx: tx as never,
      assertOwnerCurrent: vi.fn().mockResolvedValue(true) })).toBe(true)
    expect(rootProof).toHaveBeenCalledWith({}, tx)
    expect(auditOwner.assertCurrent).toBeDefined()
    expect(rootOwner.assertCurrent).toBeDefined()
  })

  it('uses the child Gate input and child owner for Audit continuation resumes only', async () => {
    const shared = { owner, snapshot: {}, attestation: {}, continuationKey: 'key', claimToken: 'claim', ownedJobs: [],
      persistedCheckpoint: {}, prepareProof: {}, gateCompletionProof: { completion: true } }
    const audit = { ...shared, auditActor }
    const analyzeCheckpoint = { nextStage: 'prepare' }
    const gate = { taskId: 'gate', attemptCount: 2 }
    await loadScheduledTaskGraphResumeGateInput(audit, analyzeCheckpoint, gate)
    expect(auditGateInput).toHaveBeenCalledWith({ owner, snapshot: shared.snapshot, analyzeCheckpoint,
      analyzeAttestation: shared.attestation, prepareProof: shared.prepareProof,
      gate: { ...gate, phase: 'completed', completionProof: shared.gateCompletionProof }, auditActor })
    await expect(scheduledTaskGraphGateResumeOwnerIsCurrent(audit)).resolves.toBe(true)
    expect(auditOwnerCurrent).toHaveBeenCalledWith({ owner, auditActor, key: 'key', claimToken: 'claim' })

    await loadScheduledTaskGraphResumeGateInput(shared, analyzeCheckpoint, gate)
    await expect(scheduledTaskGraphGateResumeOwnerIsCurrent(shared)).resolves.toBe(true)
    expect(rootGateInput).toHaveBeenCalledWith({ owner, snapshot: shared.snapshot, analyzeCheckpoint,
      analyzeAttestation: shared.attestation, prepareProof: shared.prepareProof,
      gate: { ...gate, phase: 'completed', completionProof: shared.gateCompletionProof } })
    expect(rootOwnerCurrent).toHaveBeenCalledWith(owner, 'key', 'claim')
  })

  it('preserves the existing root-only execution state and lease rules', () => {
    const root = { id: 'root', sessionId: 'session', turnId: 'turn', rootTaskId: 'root', parentTaskId: null,
      attemptCount: 1, status: 'running', interruptRequestedAt: null, closedAt: null }
    const turn = { status: 'in_progress', leaseOwnerId: owner.turnLeaseOwnerId, leaseVersion: owner.turnLeaseVersion,
      leaseExpiresAt: new Date(Date.now() + 60_000) }
    expect(scheduledRootIdentityMatches(root, owner)).toBe(true)
    expect(scheduledRootIsCurrent(root, owner)).toBe(true)
    expect(scheduledRootIsCurrent({ ...root, status: 'waiting' }, owner)).toBe(false)
    expect(scheduledTurnLeaseIsCurrent(turn, owner)).toBe(true)
    expect(scheduledTurnLeaseIsCurrent({ ...turn, status: 'waiting_for_dependency', leaseOwnerId: null,
      leaseExpiresAt: null }, owner)).toBe(false)
  })

  it('checks the actor through the ordered child fence', async () => {
    await expect(scheduledAuditChildIsCurrent(owner, auditActor)).resolves.toBe(true)
    expect(childCurrent).toHaveBeenCalledWith(tx, { owner, auditActor })
  })

  it('keeps actor fencing distinct from proof loading for a continuation', async () => {
    const load = vi.fn().mockResolvedValue({ continuation: true })
    lockChild.mockResolvedValueOnce(null)
    await expect(lockScheduledAuditContinuation({ owner, auditActor, load })).resolves.toEqual({ status: 'actor_fenced' })
    expect(load).not.toHaveBeenCalled()
    await expect(lockScheduledAuditContinuation({ owner, auditActor, load })).resolves.toEqual({ status: 'locked', value: { continuation: true } })
    expect(load).toHaveBeenCalledOnce()
    await expect(lockScheduledAuditContinuation({ owner, auditActor, load: async () => null })).resolves.toEqual({ status: 'proof_invalid' })
  })

  it('returns only a replay response after the continuation claim loses its fence', async () => {
    const replay = Response.json({ status: 'completed' })
    await expect(scheduledAuditClaimRaceResponse(Promise.resolve(replay))).resolves.toBe(replay)
    const failed = await scheduledAuditClaimRaceResponse(Promise.resolve({ kind: 'scheduled_audit_execute' }))
    expect(failed.status).toBe(409)
    await expect(failed.json()).resolves.toEqual({ status: 'blocked', errorCode: 'scheduled_pipeline_execution_mismatch' })
  })

  it('does not claim a continuation after the owner fence fails', async () => {
    ownerFence.mockReturnValue(vi.fn().mockResolvedValue(false))
    await expect(claimScheduledAuditExecution({ owner, auditActor, key: 'key', currentClaimToken: 'claim',
      executionStatus: 'running', executionAttemptCount: 3, currentState: {}, nextState: {} })).resolves.toBe(false)
    expect(db.agentExecution.updateMany).not.toHaveBeenCalled()
  })

  it('updates the exact execution CAS only after the live Audit owner fence', async () => {
    const currentState = { scheduledTaskGraphClaim: { claimToken: 'old' } }, nextState = { scheduledTaskGraphClaim: { claimToken: 'new' } }
    const input = { owner, auditActor, key: 'key', currentClaimToken: 'old', executionStatus: 'running' as const,
      executionAttemptCount: 3, currentState, nextState }
    await expect(claimScheduledAuditExecution(input)).resolves.toBe(true)
    expect(ownerFence).toHaveBeenCalledWith({ owner, auditActor, key: 'key', claimToken: 'old' })
    expect(db.agentExecution.updateMany).toHaveBeenCalledWith({
      where: { id: 'execution', userId: 'user', sessionId: 'session', status: 'running', attemptCount: 3,
        state: { equals: currentState } },
      data: { status: 'running', state: nextState },
    })
  })

  it('returns false when the fenced execution CAS loses', async () => {
    db.agentExecution.updateMany.mockResolvedValue({ count: 0 })
    await expect(claimScheduledAuditExecution({ owner, auditActor, key: 'key', currentClaimToken: 'claim',
      executionStatus: 'running', executionAttemptCount: 3, currentState: {}, nextState: {} })).resolves.toBe(false)
  })
})
