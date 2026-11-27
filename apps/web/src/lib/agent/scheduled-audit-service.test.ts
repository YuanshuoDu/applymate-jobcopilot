import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTaskGraphRunInput } from './scheduled-taskgraph-audit-action'

const mocks = vi.hoisted(() => ({
  execution: vi.fn(), config: vi.fn(), resume: vi.fn(), recorder: vi.fn(), attempt: vi.fn(), active: vi.fn(), history: vi.fn(),
  ownerCurrent: vi.fn(), saveCheckpoint: vi.fn(), finish: vi.fn(), buildGate: vi.fn(), saveRoleRun: vi.fn(),
  runAudit: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ db: { agentExecution: { findFirst: mocks.execution }, agentConfig: { findUnique: mocks.config },
  resume: { findFirst: mocks.resume } } }))
vi.mock('@/lib/agent/session/run-recorder', () => ({ createRunSessionRecorder: mocks.recorder }))
vi.mock('@/lib/agent/run-service-helpers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/agent/run-service-helpers')>('@/lib/agent/run-service-helpers')
  return { ...actual, createRunAttemptOwnership: mocks.attempt, isActiveAccount: mocks.active, saveHistory: mocks.history }
})
vi.mock('@/lib/agent/scheduled-taskgraph-audit-action', () => ({
  scheduledTaskGraphRunOwnerFence: () => ({ assertCurrent: async () => true, isCurrent: mocks.ownerCurrent }),
  scheduledTaskGraphRunCheckpointIsCurrent: async () => true,
}))
vi.mock('@/lib/agent/scheduled-taskgraph-run-service', () => ({
  buildScheduledTaskGraphGateResumeState: mocks.buildGate, serializeScheduledTaskGraphCheckpoint: (state: unknown) => state,
}))
vi.mock('@/lib/agent/scheduled-taskgraph-pipeline-checkpoint', () => ({ scheduledTaskGraphContinuationKey: () => 'continuation-1' }))
vi.mock('@/lib/agent/scheduled-taskgraph-pipeline-fence', () => ({
  finishScheduledTaskGraphExecution: mocks.finish, saveScheduledTaskGraphCheckpoint: mocks.saveCheckpoint,
  scheduledTaskGraphClaimMatches: () => true,
}))
vi.mock('@/lib/agent/scheduled-taskgraph-gate-rpc', () => ({
  scheduledTaskGraphExecuteGateCompletionProof: () => ({ gate: { taskId: 'gate-1', attemptCount: 1 } }),
}))
vi.mock('@/lib/agent/scheduled-automation-snapshot', () => ({ parseScheduledAutomationSnapshot: () => ({ autoApply: false }) }))
vi.mock('@/lib/agent/stages/audit', () => ({ runScheduledAudit: mocks.runAudit }))
vi.mock('@/lib/agent/stages/custom', () => ({ summarizeCustomAgentResults: () => [] }))
vi.mock('@/lib/agent/role-config', () => ({ recordRoleRun: mocks.saveRoleRun }))

import { runScheduledAuditService } from './scheduled-audit-service'

const owner = { userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1', rootAttemptCount: 2,
  turnLeaseOwnerId: 'worker-1', turnLeaseVersion: 4, executionId: 'execution-1', executionAttemptCount: 3 }
const admittedJobs = ([{ id: 'job-1', userId: owner.userId }, { id: 'job-2', userId: owner.userId },
  { id: 'job-3', userId: owner.userId }] as unknown as ScheduledTaskGraphRunInput['ownedJobs'])
const scheduled = { action: 'scheduled_audit_execute' as const, owner, snapshot: {}, attestation: {},
  continuationKey: 'continuation-1', claimToken: 'claim-1', ownedJobs: admittedJobs, prepareProof: {}, gateCompletionProof: {},
  auditActor: { taskId: 'audit-1', attemptCount: 2, leaseOwner: 'audit-worker-1' } }
const gateState = {
  nextStage: 'execute' as const, eventIndex: 4,
  scoutedJobs: [{ id: 'job-1', userId: owner.userId }, { id: 'job-2', userId: owner.userId }, { id: 'job-3', userId: owner.userId }],
  scoredJobs: [{ job: { id: 'job-1', userId: owner.userId }, score: 80 }, { job: { id: 'job-2', userId: owner.userId }, score: 72 }], analysisFailed: 1,
  preparedPackages: [], gateOutput: { approved: [{ job: { company: 'Example', role: 'Engineer' } }], pending: [{}], skipped: [] },
  executeOutput: { queued: ['job-1'], failed: ['job-2'] },
}
const recorded: Array<{ event: string; data: unknown }> = []
let recorderActivate: ReturnType<typeof vi.fn>
let recorderFinalize: ReturnType<typeof vi.fn>

describe('runScheduledAuditService', () => {
  beforeEach(() => {
    vi.clearAllMocks(); recorded.length = 0
    mocks.execution.mockResolvedValue({ id: owner.executionId, status: 'running', attemptCount: owner.executionAttemptCount,
      state: { nextStage: 'audit', eventIndex: 4 } })
    mocks.config.mockResolvedValue({ userId: owner.userId })
    mocks.resume.mockResolvedValue({ id: 'resume-1' })
    mocks.active.mockResolvedValue(true)
    mocks.ownerCurrent.mockResolvedValue(true)
    mocks.saveCheckpoint.mockResolvedValue(true)
    mocks.finish.mockResolvedValue(true)
    mocks.buildGate.mockResolvedValue({ ...gateState })
    mocks.saveRoleRun.mockResolvedValue(undefined)
    mocks.history.mockResolvedValue(undefined)
    mocks.runAudit.mockResolvedValue({ warnings: [], observations: ['verified', 'synced'], durationMs: 7 })
    recorderActivate = vi.fn(async () => true)
    recorderFinalize = vi.fn(async () => true)
    mocks.recorder.mockResolvedValue({
      sessionId: owner.sessionId, getTurnId: () => owner.turnId,
      activate: recorderActivate, record: vi.fn(async (event: string, data: unknown) => { recorded.push({ event, data }) }),
      finalize: recorderFinalize,
    })
    mocks.attempt.mockReturnValue({ isCurrentAttempt: async () => true, canPublishAttemptResult: async () => true })
  })

  it('runs the held Execute projection and typed Audit with the seven-field report and owned terminalization', async () => {
    const report = await runScheduledAuditService({ scheduled })

    expect(report).toMatchObject({ processed: 3, applied: 0, queued: 1, pending: 1, skipped: 1, failed: 1 })
    expect(mocks.runAudit).toHaveBeenCalledWith(expect.objectContaining({ userId: owner.userId, executeOutput: gateState.executeOutput }))
    expect(mocks.saveCheckpoint).toHaveBeenCalledTimes(5)
    expect(mocks.finish).toHaveBeenCalledOnce()
    expect(mocks.history).toHaveBeenCalledOnce()
    expect(mocks.saveCheckpoint.mock.invocationCallOrder[0]).toBeLessThan(mocks.runAudit.mock.invocationCallOrder[0])
    expect(mocks.runAudit.mock.invocationCallOrder[0]).toBeLessThan(mocks.finish.mock.invocationCallOrder[0])
    expect(mocks.runAudit.mock.invocationCallOrder[0]).toBeLessThan(mocks.saveCheckpoint.mock.invocationCallOrder.at(-1)!)
    expect(mocks.saveCheckpoint.mock.invocationCallOrder.at(-1)!).toBeLessThan(mocks.finish.mock.invocationCallOrder[0])
    expect(mocks.execution).toHaveBeenCalledWith({ where: { id: owner.executionId, userId: owner.userId,
      sessionId: owner.sessionId, status: 'running', attemptCount: owner.executionAttemptCount },
      select: { id: true, status: true, attemptCount: true, state: true } })
    expect(mocks.recorder).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: owner.userId,
      sessionId: owner.sessionId, turnId: owner.turnId, source: 'automation', dualWrite: true,
      manageV2Lifecycle: false, manageSessionLifecycle: false, deferActivation: true, ensureTurn: true }))
    expect(recorderActivate).toHaveBeenCalledWith(expect.objectContaining({ executionAttempt: {
      id: owner.executionId, attemptCount: owner.executionAttemptCount }, assertCurrent: expect.any(Function) }))
    expect(recorded.some(row => row.event === 'agent_plan' && (row.data as { role?: string }).role === 'executor')).toBe(true)
    expect(recorded.some(row => row.event === 'agent_plan' && (row.data as { role?: string }).role === 'auditor')).toBe(true)
    expect(recorded.some(row => row.event === 'agent_observation' && (row.data as { role?: string }).role === 'executor')).toBe(true)
    expect(recorded.some(row => row.event === 'agent_observation' && (row.data as { role?: string }).role === 'auditor')).toBe(true)
    expect(recorded.some(row => row.event === 'agent_reflect' && (row.data as { role?: string }).role === 'executor')).toBe(true)
    expect(recorded.some(row => row.event === 'agent_reflect' && (row.data as { role?: string }).role === 'auditor')).toBe(true)
    expect(recorded.some(row => row.event === 'stage_done' && (row.data as { stage?: string }).stage === 'execute')).toBe(true)
    expect(recorded.some(row => row.event === 'stage_done' && (row.data as { stage?: string }).stage === 'audit')).toBe(true)
    expect(recorded.map(row => row.event)).toContain('orchestrator_complete')
    expect(recorded.map(row => row.event)).toContain('done')
    expect(recorded.some(row => row.event === 'role_start' || row.event === 'role_done')).toBe(false)
    expect(mocks.finish.mock.invocationCallOrder[0]).toBeLessThan(recorderFinalize.mock.invocationCallOrder[0])
    expect(recorderFinalize).toHaveBeenCalledWith({ status: 'completed', report,
      owner: { turnId: owner.turnId, executionAttempt: { id: owner.executionId, userId: owner.userId,
        attemptCount: owner.executionAttemptCount }, terminalStatus: 'completed' } })
  })

  it('does not publish audit observations or terminal state when the child lease is lost during Gmail sync', async () => {
    let checkpointCountAtSync = 0
    let eventCountAtSync = 0
    mocks.buildGate.mockResolvedValue({ ...gateState, nextStage: 'audit' })
    mocks.runAudit.mockImplementation(async (input: { assertCurrent: () => Promise<boolean> }) => {
      checkpointCountAtSync = mocks.saveCheckpoint.mock.calls.length
      eventCountAtSync = recorded.length
      expect(await input.assertCurrent()).toBe(true)
      mocks.ownerCurrent.mockResolvedValue(false)
      return { warnings: [], observations: ['stale sync result'], durationMs: 7 }
    })

    const report = await runScheduledAuditService({ scheduled })

    expect(report).toBeNull()
    expect(mocks.saveCheckpoint).toHaveBeenCalledTimes(checkpointCountAtSync)
    expect(mocks.finish).not.toHaveBeenCalled()
    expect(mocks.history).not.toHaveBeenCalled()
    expect(recorded).toHaveLength(eventCountAtSync)
    expect(recorded.some(row => row.event === 'agent_observation' || row.event === 'done' || row.event === 'agent_reflect'
      || row.event === 'orchestrator_complete' || row.event === 'stage_done')).toBe(false)
    expect(recorderFinalize).not.toHaveBeenCalled()
  })

  it('rejects queued or failed IDs outside the attested candidate set before checkpoint or Gmail work', async () => {
    mocks.buildGate.mockResolvedValue({ ...gateState, executeOutput: { queued: ['foreign-job'], failed: [] } })

    const report = await runScheduledAuditService({ scheduled })

    expect(report).toBeNull()
    expect(mocks.saveCheckpoint).not.toHaveBeenCalled()
    expect(mocks.runAudit).not.toHaveBeenCalled()
    expect(mocks.finish).not.toHaveBeenCalled()
  })

  it('rejects an empty owner user before loading execution state', async () => {
    const result = await runScheduledAuditService({ scheduled: { ...scheduled, owner: { ...owner, userId: '' } },
      })

    expect(result).toBeNull()
    expect(mocks.execution).not.toHaveBeenCalled()
  })
})
