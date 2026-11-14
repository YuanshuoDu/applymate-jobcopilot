import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  turn: vi.fn(), execution: vi.fn(), user: vi.fn(), jobs: vi.fn(), agentConfig: vi.fn(), resume: vi.fn(), tasks: vi.fn(),
  parseAttestation: vi.fn(), snapshot: vi.fn(), snapshotDigest: vi.fn(), continuationKey: vi.fn(), candidates: vi.fn(),
  gateProof: vi.fn(), gateInput: vi.fn(), parseHandoff: vi.fn(), executeEnvelope: vi.fn(),
  loadAi: vi.fn(), resolveConfig: vi.fn(), agentConfigFrom: vi.fn(), overrides: vi.fn(), withOverrides: vi.fn(),
  roleConfigs: vi.fn(), roleConfigMap: vi.fn(), resumeText: vi.fn(), runExecute: vi.fn(), runAudit: vi.fn(),
}))

vi.mock('@jobcopilot/agent-protocol', () => ({ parseScheduledPipelineAttestation: mocks.parseAttestation }))
vi.mock('@/lib/db', () => ({ db: {
  agentTurn: { findFirst: mocks.turn }, agentExecution: { findFirst: mocks.execution }, user: { findUnique: mocks.user },
  job: { findMany: mocks.jobs }, agentConfig: { findUnique: mocks.agentConfig }, resume: { findFirst: mocks.resume },
  subAgentTask: { findMany: mocks.tasks },
} }))
vi.mock('@/lib/model-router', () => ({ APPLYMATE_BACKING: {}, loadUserAiConfig: mocks.loadAi, resolveConfig: mocks.resolveConfig }))
vi.mock('@/app/api/agent/run/run-helpers', () => ({ pipelineAgentConfigFrom: mocks.agentConfigFrom }))
vi.mock('./automation-overrides', () => ({ automationRunOverrides: mocks.overrides, withAutomationOverrides: mocks.withOverrides }))
vi.mock('./role-config', () => ({ loadRoleConfigs: mocks.roleConfigs, toRoleConfigMap: mocks.roleConfigMap }))
vi.mock('./types', () => ({ resumeToText: mocks.resumeText }))
vi.mock('./stages/execute', () => ({ runExecute: mocks.runExecute }))
vi.mock('./stages/audit', () => ({ runAudit: mocks.runAudit }))
vi.mock('./scheduled-automation-snapshot', () => ({ parseScheduledAutomationSnapshot: mocks.snapshot }))
vi.mock('./scheduled-taskgraph-pipeline-checkpoint', () => ({
  scheduledAutomationSnapshotDigest: mocks.snapshotDigest, scheduledTaskGraphContinuationKey: mocks.continuationKey,
}))
vi.mock('./scheduled-taskgraph-attestation-candidates', () => ({ scheduledTaskGraphAttestationCandidates: mocks.candidates }))
vi.mock('./scheduled-taskgraph-gate-rpc', () => ({ scheduledTaskGraphExecuteGateCompletionProof: mocks.gateProof }))
vi.mock('./scheduled-taskgraph-gate-input', () => ({ loadScheduledTaskGraphPostGateGateInput: mocks.gateInput }))
vi.mock('./scheduled-taskgraph-post-gate-proof', () => ({
  parseScheduledPostGateExecuteEnvelope: mocks.executeEnvelope, parseScheduledPostGateHandoff: mocks.parseHandoff,
}))

import { isScheduledTaskGraphPostGateAction, runScheduledTaskGraphPostGateTask } from './scheduled-taskgraph-post-gate-task'

const owner = { userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1', rootAttemptCount: 1,
  turnLeaseOwnerId: 'turn-owner-1', turnLeaseVersion: 2, executionId: 'execution-1', executionAttemptCount: 3 }
const snapshot = { schemaVersion: 'agent-harness.v2.scheduled-automation-snapshot.v1', targetRoles: ['Engineer'], targetLocations: ['Dublin'],
  minScore: 70, dailyCap: 5, requireApproval: true, autoApply: false }
const attestation = { owner: { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
  rootTaskId: owner.rootTaskId, rootAttemptCount: owner.rootAttemptCount } }
const gateProof = { prepareProof: { receipt: { checkpointDigest: 'checkpoint' } }, gate: { taskId: 'gate-1', attemptCount: 2 } }
const handoff = { owner, snapshotDigest: 'snapshot-digest', continuationKey: 'continuation-1', gateProof,
  executeNodes: [{ key: 'execute-1', taskId: 'execute-task-1', packageRefs: ['job-1'] }], auditTaskId: 'audit-task-1' }
const applicationPackage = { job: { id: 'job-1', userId: owner.userId, company: 'Example Co', role: 'Engineer' }, score: 90,
  matchedKeywords: ['TypeScript'], missingKeywords: [], recommendation: 'Strong match.' }
const gateInput = { packages: [{ userId: owner.userId, sessionId: owner.sessionId, jobId: 'job-1', package: applicationPackage }],
  materials: [], gateResult: { status: 'completed', nextStage: 'execute', approvedJobIds: [], pendingJobIds: ['job-1'], skippedJobIds: [],
    counts: { approved: 0, pending: 1, skipped: 0 } } }
const ownedJob = { id: 'job-1', userId: owner.userId, company: 'Example Co', role: 'Engineer' }
const checkpoint = { nextStage: 'execute', startedAt: new Date().toISOString(), scoutedJobs: [ownedJob], analysisFailed: 0 }
const resume = { id: 'resume-1', name: 'Base resume', content: { summary: 'Engineer' }, templateId: null, templateOptions: null,
  directionId: null, basicsDetached: false }

function request(action: 'scheduled_post_gate_execute' | 'scheduled_post_gate_audit') {
  const actor = action === 'scheduled_post_gate_execute'
    ? { taskId: 'execute-task-1', attemptCount: 2, leaseOwner: 'execute-worker-2' }
    : { taskId: 'audit-task-1', attemptCount: 3, leaseOwner: 'audit-worker-3' }
  return { action, owner, handoff: {}, attestation: {}, actor,
    ...(action === 'scheduled_post_gate_execute' ? { packageRefs: ['job-1'] } : {}) }
}

describe('scheduled TaskGraph post-Gate task runner', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset()
    mocks.turn.mockResolvedValue({ source: 'automation', executionMode: 'canonical_task_graph', rootTaskId: owner.rootTaskId,
      input: { automationRunMode: 'scheduled', scheduledAutomationSnapshot: snapshot } })
    mocks.execution.mockResolvedValue({ id: owner.executionId, status: 'running', attemptCount: owner.executionAttemptCount, state: checkpoint })
    mocks.user.mockResolvedValue({ accountStatus: 'active' })
    mocks.jobs.mockResolvedValue([ownedJob])
    mocks.agentConfig.mockResolvedValue({ id: 'agent-config-1' })
    mocks.resume.mockResolvedValue(resume)
    mocks.tasks.mockResolvedValue([{ id: 'execute-task-1', status: 'completed', result: {} }])
    mocks.parseAttestation.mockReturnValue(attestation)
    mocks.snapshot.mockReturnValue(snapshot)
    mocks.snapshotDigest.mockReturnValue('snapshot-digest')
    mocks.continuationKey.mockReturnValue('continuation-1')
    mocks.candidates.mockReturnValue({ selectedJobIds: new Set(['job-1']) })
    mocks.gateProof.mockReturnValue(gateProof)
    mocks.gateInput.mockResolvedValue(gateInput)
    mocks.parseHandoff.mockReturnValue(handoff)
    mocks.executeEnvelope.mockReturnValue({ queued: [], failed: [] })
    mocks.loadAi.mockResolvedValue({ resolvedKey: null })
    mocks.resolveConfig.mockReturnValue({ provider: 'minimax', model: 'MiniMax-M3', apiKey: 'platform-key' })
    mocks.agentConfigFrom.mockReturnValue({ minMatchScore: 70 })
    mocks.overrides.mockReturnValue({})
    mocks.withOverrides.mockReturnValue({ minMatchScore: 70 })
    mocks.roleConfigs.mockResolvedValue([])
    mocks.roleConfigMap.mockReturnValue({})
    mocks.resumeText.mockReturnValue('Engineer resume')
    mocks.runExecute.mockResolvedValue({ ok: true, data: { queued: [], failed: [] } })
    mocks.runAudit.mockResolvedValue({ ok: true, data: { report: {}, warnings: [] } })
  })

  it.each(['scheduled_post_gate_execute', 'scheduled_post_gate_audit'] as const)('recognizes and dispatches the fixed %s action', async action => {
    expect(isScheduledTaskGraphPostGateAction({ action })).toBe(true)
    const response = await runScheduledTaskGraphPostGateTask({ action })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ status: 'blocked', errorCode: 'scheduled_post_gate_request_invalid' })
  })

  it.each([null, 'scheduled_post_gate_execute', { action: 'scheduled_pipeline_execute' }])(
    'rejects malformed or non-post-Gate input before accessing runtime state', async value => {
      expect(isScheduledTaskGraphPostGateAction(value)).toBe(false)
      const response = await runScheduledTaskGraphPostGateTask(value)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ status: 'blocked', errorCode: 'scheduled_post_gate_request_invalid' })
    })

  it('runs Execute only with the exact Gate-approved package partition and never submits', async () => {
    const response = await runScheduledTaskGraphPostGateTask(request('scheduled_post_gate_execute'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'completed', structuredResult: { queued: [], failed: [] } })
    expect(mocks.runExecute).toHaveBeenCalledWith([applicationPackage], expect.objectContaining({ userId: owner.userId }))
    expect(mocks.gateInput.mock.calls[0]?.[0]).toMatchObject({
      postGate: { actor: { kind: 'execute', taskId: 'execute-task-1' }, handoff, packageRefs: ['job-1'] },
    })
    expect(mocks.runAudit).not.toHaveBeenCalled()
  })

  it('rejects a package partition that differs from the immutable Execute node', async () => {
    const response = await runScheduledTaskGraphPostGateTask({ ...request('scheduled_post_gate_execute'), packageRefs: ['job-2'] })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ status: 'blocked', errorCode: 'scheduled_post_gate_request_invalid' })
    expect(mocks.runExecute).not.toHaveBeenCalled()
  })

  it('blocks Execute output if the child or execution attempt fence is stale after the stage', async () => {
    mocks.gateInput.mockResolvedValueOnce(gateInput).mockResolvedValueOnce(null)
    const response = await runScheduledTaskGraphPostGateTask(request('scheduled_post_gate_execute'))
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ status: 'blocked', errorCode: 'scheduled_post_gate_actor_fenced' })
    expect(mocks.runExecute).toHaveBeenCalledOnce()
  })

  it('runs the existing Audit without Gmail and returns the fixed seven-field report', async () => {
    const response = await runScheduledTaskGraphPostGateTask(request('scheduled_post_gate_audit'))
    expect(response.status).toBe(200)
    const body = await response.json() as { status: string; report: Record<string, number> }
    expect(body.status).toBe('completed')
    expect(body.report).toMatchObject({ processed: 1, applied: 0, queued: 0, pending: 1, skipped: 0, failed: 0 })
    expect(Object.keys(body.report).sort()).toEqual(['applied', 'durationMs', 'failed', 'pending', 'processed', 'queued', 'skipped'])
    expect(mocks.runAudit).toHaveBeenCalledWith({ queued: [], failed: [] }, [ownedJob], expect.any(Object), { syncGmail: false })
    expect(mocks.runExecute).not.toHaveBeenCalled()
  })
})
