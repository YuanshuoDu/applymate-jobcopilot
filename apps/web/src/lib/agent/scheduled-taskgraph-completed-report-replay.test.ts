import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  execution: vi.fn(), turn: vi.fn(), root: vi.fn(), session: vi.fn(), jobs: vi.fn(), transaction: vi.fn(),
  digest: vi.fn(), key: vi.fn(), completedReport: vi.fn(), prior: vi.fn(), gateProof: vi.fn(), validatePrepare: vi.fn(), snapshot: vi.fn(),
  auditGateProof: vi.fn(), auditFence: vi.fn(), auditPrepareSource: vi.fn(), queryRaw: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ db: {
  agentExecution: { findFirst: mocks.execution }, agentTurn: { findFirst: mocks.turn }, subAgentTask: { findFirst: mocks.root },
  agentSession: { findFirst: mocks.session }, job: { findMany: mocks.jobs }, $transaction: mocks.transaction,
} }))
vi.mock('./scheduled-taskgraph-analysis-journal', () => ({ completedScheduledTaskGraphReport: mocks.completedReport }))
vi.mock('./scheduled-taskgraph-gate-input', () => ({ isScheduledTaskGraphGateProofCurrent: mocks.gateProof,
  isScheduledTaskGraphAuditChildGateProofCurrent: mocks.auditGateProof }))
vi.mock('./scheduled-taskgraph-audit-child-fence', () => ({ lockScheduledTaskGraphAuditChildFence: mocks.auditFence }))
vi.mock('./scheduled-taskgraph-audit-prepare-source', () => ({ validateScheduledTaskGraphAuditPrepareSource: mocks.auditPrepareSource }))
vi.mock('./scheduled-automation-snapshot', () => ({ parseScheduledAutomationSnapshot: mocks.snapshot }))
vi.mock('./scheduled-taskgraph-pipeline-checkpoint', () => ({
  scheduledAutomationSnapshotDigest: mocks.digest, scheduledTaskGraphContinuationKey: mocks.key,
}))
vi.mock('./scheduled-taskgraph-pipeline-fence', () => ({ priorScheduledTaskGraphContinuation: mocks.prior }))
vi.mock('./scheduled-taskgraph-run-service', () => ({ validateScheduledPrepareWaitIdentity: mocks.validatePrepare }))

import { replayCompletedScheduledTaskGraphAuditReport, replayCompletedScheduledTaskGraphReport } from './scheduled-taskgraph-completed-report-replay'

const requestOwner = { userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1', rootAttemptCount: 2,
  turnLeaseOwnerId: 'worker-1', turnLeaseVersion: 4 }
const owner = { ...requestOwner, executionId: 'execution-1', executionAttemptCount: 5 }
const snapshot = { schemaVersion: 'agent-harness.v2.scheduled-automation-snapshot.v1', requireApproval: false, autoApply: true }
const attestation = { snapshotDigest: 'sha256:snapshot', scout: { candidateJobIds: ['job-1'] } }
const prepareProof = { receipt: 'prepare' }
const gateCompletionProof = { schemaVersion: 'agent-harness.v2.scheduled-taskgraph-gate-completion.v1', prepareProof,
  gate: { taskId: 'gate-1', attemptCount: 2 } }
const report = { processed: 1, applied: 0, queued: 0, pending: 0, skipped: 1, failed: 0, durationMs: 9 }
const execution = { id: owner.executionId, status: 'completed', attemptCount: owner.executionAttemptCount, state: { nextStage: 'completed' } }
const turn = { id: owner.turnId, userId: owner.userId, sessionId: owner.sessionId, rootTaskId: owner.rootTaskId,
  source: 'automation', executionMode: 'canonical_task_graph', input: { automationRunMode: 'scheduled', scheduledAutomationSnapshot: {} },
  status: 'in_progress', leaseOwnerId: owner.turnLeaseOwnerId, leaseVersion: owner.turnLeaseVersion,
  leaseExpiresAt: new Date(Date.now() + 60_000) }
const root = { id: owner.rootTaskId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
  parentTaskId: null, status: 'running', attemptCount: owner.rootAttemptCount, interruptRequestedAt: null, closedAt: null }
const job = { id: 'job-1', userId: owner.userId }
const request = { action: 'execute' as const, owner: requestOwner, attestation, prepareProof, gateCompletionProof }
const auditRequest = { ...request, action: 'scheduled_audit_execute' as const,
  auditActor: { taskId: 'audit-task', attemptCount: 2, leaseOwner: 'audit-worker-2' } }
const gate = { taskId: 'gate-1', attemptCount: 2 }
let lockedTransaction: unknown

beforeEach(() => {
  Object.values(mocks).forEach(mock => mock.mockReset())
  mocks.execution.mockResolvedValue(execution)
  mocks.turn.mockResolvedValue({ ...turn, leaseExpiresAt: new Date(Date.now() + 60_000) })
  mocks.root.mockResolvedValue(root)
  mocks.session.mockResolvedValue({ id: owner.sessionId, status: 'active' })
  mocks.jobs.mockResolvedValue([job])
  lockedTransaction = { $queryRaw: mocks.queryRaw }
  mocks.transaction.mockImplementation(async (work: (tx: unknown) => unknown) => work(lockedTransaction))
  mocks.queryRaw.mockResolvedValue([execution])
  mocks.digest.mockReturnValue(attestation.snapshotDigest)
  mocks.key.mockReturnValue('continuation-key')
  mocks.completedReport.mockReturnValue(report)
  mocks.prior.mockReturnValue(null)
  mocks.gateProof.mockResolvedValue(true)
  mocks.auditGateProof.mockResolvedValue(true)
  mocks.auditFence.mockResolvedValue(true)
  mocks.auditPrepareSource.mockResolvedValue(true)
  mocks.validatePrepare.mockResolvedValue(true)
  mocks.snapshot.mockReturnValue(snapshot)
})

describe('completed scheduled TaskGraph report replay', () => {
  it('replays an exact completed report to a live Audit retry after Root parked and released its Turn lease', async () => {
    mocks.turn.mockResolvedValue({ ...turn, status: 'waiting_for_dependency', leaseOwnerId: null, leaseExpiresAt: null })
    mocks.root.mockResolvedValue({ ...root, status: 'waiting' })
    mocks.session.mockResolvedValue({ id: owner.sessionId, status: 'running' })

    const response = await replayCompletedScheduledTaskGraphAuditReport(auditRequest, gate)

    expect(response?.status).toBe(200)
    expect(await response?.json()).toEqual({ status: 'completed', report })
    expect(mocks.completedReport).toHaveBeenCalledWith(expect.objectContaining({ owner, execution }))
    expect(mocks.auditGateProof).toHaveBeenCalledWith(expect.objectContaining({ owner,
      auditActor: auditRequest.auditActor, gate: expect.objectContaining({ taskId: gate.taskId, phase: 'completed' }) }), lockedTransaction)
    expect(mocks.auditFence).toHaveBeenCalledWith(lockedTransaction, { owner, auditActor: auditRequest.auditActor })
    expect(mocks.auditPrepareSource).toHaveBeenCalledWith(expect.objectContaining({ owner, reader: lockedTransaction }))
    expect(mocks.queryRaw).toHaveBeenCalledOnce()
    expect(mocks.gateProof).not.toHaveBeenCalled()
    expect(mocks.transaction).toHaveBeenCalledOnce()
  })

  it('allows the dispatched Audit actor attempt to differ from the historical Root wait attempt', async () => {
    mocks.turn.mockResolvedValue({ ...turn, status: 'queued', leaseOwnerId: null, leaseExpiresAt: null })
    mocks.root.mockResolvedValue({ ...root, status: 'waiting' })
    mocks.session.mockResolvedValue({ id: owner.sessionId, status: 'running' })

    const response = await replayCompletedScheduledTaskGraphAuditReport({ ...auditRequest,
      auditActor: { ...auditRequest.auditActor, attemptCount: 3 } }, { ...gate, attemptCount: 1 })

    expect(response?.status).toBe(200)
    expect(mocks.auditGateProof).toHaveBeenCalledWith(expect.objectContaining({ auditActor: { ...auditRequest.auditActor, attemptCount: 3 } }), lockedTransaction)
  })

  it('rejects terminal parents before report replay and uses only the actor proof path', async () => {
    mocks.turn.mockResolvedValue({ ...turn, status: 'completed', leaseOwnerId: null, leaseExpiresAt: null })
    mocks.root.mockResolvedValue({ ...root, status: 'completed', closedAt: new Date() })
    mocks.session.mockResolvedValue({ id: owner.sessionId, status: 'running' })

    const response = await replayCompletedScheduledTaskGraphAuditReport(auditRequest, gate)

    expect(await response?.json()).toMatchObject({ errorCode: 'scheduled_pipeline_owner_mismatch' })
    expect(mocks.auditGateProof).not.toHaveBeenCalled()
  })

  it('does not return a cached report when the execution changes before the locked proof check', async () => {
    mocks.turn.mockResolvedValue({ ...turn, status: 'waiting_for_dependency', leaseOwnerId: null, leaseExpiresAt: null })
    mocks.root.mockResolvedValue({ ...root, status: 'waiting' })
    mocks.session.mockResolvedValue({ id: owner.sessionId, status: 'running' })
    mocks.queryRaw.mockResolvedValue([{ ...execution, state: { nextStage: 'completed', changed: true } }])

    const response = await replayCompletedScheduledTaskGraphAuditReport(auditRequest, gate)

    expect(await response?.json()).toMatchObject({ errorCode: 'scheduled_pipeline_gate_proof_invalid' })
    expect(mocks.auditGateProof).not.toHaveBeenCalled()
    expect(mocks.queryRaw).toHaveBeenCalledOnce()
  })

  it('returns the exact report response for an approval wait after a lost response', async () => {
    const waitId = `agent-question:${owner.turnId}:canonical:${'a'.repeat(64)}`
    const approvedSnapshot = { ...snapshot, requireApproval: true }
    const approvedTurn = { ...turn, status: 'waiting_for_user', leaseOwnerId: null, leaseExpiresAt: null }
    const approvedExecution = { ...execution, state: { ...execution.state, scheduledTaskGraphScheduledWaitId: waitId } }
    const approvedRequest = { ...request, scheduledWaitId: waitId }
    mocks.snapshot.mockReturnValue(approvedSnapshot)
    mocks.turn.mockResolvedValue(approvedTurn)
    mocks.execution.mockResolvedValue(approvedExecution)

    const dropped = await replayCompletedScheduledTaskGraphReport(approvedRequest, gate)
    const replayed = await replayCompletedScheduledTaskGraphReport(approvedRequest, gate)

    expect(dropped?.status).toBe(200)
    expect(await replayed?.json()).toEqual({ status: 'completed', report })
    expect(mocks.execution).toHaveBeenCalledTimes(2)
    expect(mocks.completedReport).toHaveBeenCalledWith(expect.objectContaining({ owner, execution: approvedExecution }))
    expect(mocks.gateProof).toHaveBeenCalledTimes(2)
    expect(mocks.transaction).toHaveBeenCalledTimes(2)
  })

  it('rechecks Gate proof against an audit-stage copy of the completed checkpoint', async () => {
    const response = await replayCompletedScheduledTaskGraphReport(request, gate)

    expect(response?.status).toBe(200)
    expect(await response?.json()).toEqual({ status: 'completed', report })
    expect(mocks.gateProof.mock.calls[0]?.[0]).toMatchObject({
      analyzeCheckpoint: { ...execution.state, nextStage: 'audit' },
    })
    expect(execution.state.nextStage).toBe('completed')
  })

  it.each(['current', 'prior'] as const)('fails closed for an %s report with an extra key', async source => {
    const malformed = { ...report, scheduledWaitId: 'unexpected' }
    if (source === 'current') mocks.completedReport.mockReturnValue(malformed)
    else {
      mocks.completedReport.mockReturnValueOnce(null).mockReturnValueOnce(malformed)
      mocks.prior.mockReturnValue({ owner, key: 'old-key' })
    }
    const response = await replayCompletedScheduledTaskGraphReport(request, gate)
    expect(await response?.json()).toMatchObject({ errorCode: 'scheduled_pipeline_execution_mismatch' })
    expect(mocks.gateProof).not.toHaveBeenCalled()
  })

  it('fails closed when the persisted root attempt differs from the request owner', async () => {
    mocks.root.mockResolvedValue({ ...root, attemptCount: owner.rootAttemptCount + 1 })
    const response = await replayCompletedScheduledTaskGraphReport(request, gate)
    expect(response?.status).toBe(409)
    expect(await response?.json()).toMatchObject({ errorCode: 'scheduled_pipeline_owner_mismatch' })
    expect(mocks.gateProof).not.toHaveBeenCalled()
  })

  it('fails closed when an old continuation belongs to another execution attempt', async () => {
    mocks.completedReport.mockReturnValue(null)
    mocks.prior.mockReturnValue({ owner: { ...owner, executionAttemptCount: owner.executionAttemptCount - 1 }, key: 'old-key' })
    const response = await replayCompletedScheduledTaskGraphReport(request, gate)
    expect(await response?.json()).toMatchObject({ errorCode: 'scheduled_pipeline_execution_mismatch' })
    expect(mocks.gateProof).not.toHaveBeenCalled()
  })

  it('rejects a stale Prepare or Gate proof without returning the report', async () => {
    mocks.validatePrepare.mockResolvedValue(false)
    const prepareRejected = await replayCompletedScheduledTaskGraphReport(request, gate)
    expect(await prepareRejected?.json()).toMatchObject({ errorCode: 'scheduled_pipeline_claim_conflict' })

    mocks.validatePrepare.mockResolvedValue(true)
    mocks.gateProof.mockResolvedValue(false)
    const gateRejected = await replayCompletedScheduledTaskGraphReport(request, gate)
    expect(await gateRejected?.json()).toMatchObject({ errorCode: 'scheduled_pipeline_gate_proof_invalid' })
  })

  it.each(['aborted', 'archived'])('rejects a %s session', async status => {
    mocks.session.mockResolvedValue({ id: owner.sessionId, status })
    const response = await replayCompletedScheduledTaskGraphReport(request, gate)
    expect(await response?.json()).toMatchObject({ errorCode: 'scheduled_pipeline_owner_mismatch' })
  })

  it('rejects closed roots and an aborted request', async () => {
    mocks.root.mockResolvedValue({ ...root, closedAt: new Date() })
    const closed = await replayCompletedScheduledTaskGraphReport(request, gate)
    expect(await closed?.json()).toMatchObject({ errorCode: 'scheduled_pipeline_owner_mismatch' })

    const controller = new AbortController()
    controller.abort()
    const aborted = await replayCompletedScheduledTaskGraphReport(request, gate, controller.signal)
    expect(await aborted?.json()).toMatchObject({ errorCode: 'scheduled_pipeline_turn_stale' })
    expect(mocks.execution).toHaveBeenCalledOnce()
  })
})
