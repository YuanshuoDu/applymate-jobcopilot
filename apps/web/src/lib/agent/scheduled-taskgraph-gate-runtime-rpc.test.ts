import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(), queryRaw: vi.fn(), jobs: vi.fn(), update: vi.fn(), turn: vi.fn(), config: vi.fn(), resume: vi.fn(),
  active: vi.fn(), feature: vi.fn(), access: vi.fn(), entitlement: vi.fn(), aiConfig: vi.fn(), roles: vi.fn(),
  isProof: vi.fn(), auditProof: vi.fn(), auditPrepareSource: vi.fn(), loadInput: vi.fn(), buildCheckpoint: vi.fn(), validateWait: vi.fn(), executeGate: vi.fn(),
  policy: vi.fn(), completedReplay: vi.fn(), auditCompletedReplay: vi.fn(),
  childFence: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ db: {
  $transaction: mocks.transaction, agentTurn: { findFirst: mocks.turn }, agentConfig: { findUnique: mocks.config },
  resume: { findFirst: mocks.resume },
} }))
vi.mock('@/lib/model-router', () => ({ APPLYMATE_BACKING: 'default', loadUserAiConfig: mocks.aiConfig,
  resolveConfig: vi.fn(() => ({})) }))
vi.mock('@/lib/entitlements', () => ({ isActiveAccount: mocks.active, isFeatureAllowed: mocks.feature,
  resolveAiAccess: mocks.access, hasEffectiveEntitlement: mocks.entitlement }))
vi.mock('@/app/api/agent/run/run-helpers', () => ({ pipelineAgentConfigFrom: vi.fn(() => ({})) }))
vi.mock('./automation-overrides', () => ({ automationRunOverrides: vi.fn(() => ({})), withAutomationOverrides: vi.fn(() => ({})) }))
vi.mock('./types', () => ({ resumeToText: vi.fn(() => 'resume') }))
vi.mock('./role-config', () => ({ loadRoleConfigs: mocks.roles, toRoleConfigMap: vi.fn(() => ({})) }))
vi.mock('./run-service-helpers', () => ({ isActiveAccount: mocks.active }))
vi.mock('./scheduled-taskgraph-gate-checkpoint', () => ({ buildScheduledTaskGraphGateCheckpoint: mocks.buildCheckpoint }))
vi.mock('./scheduled-taskgraph-gate-input', () => ({ isScheduledTaskGraphGateProofCurrent: mocks.isProof,
  isScheduledTaskGraphAuditChildGateProofCurrent: mocks.auditProof,
  loadScheduledTaskGraphGateInput: mocks.loadInput, scheduledTaskGraphAnalyzeCheckpointForGate: (value: unknown) => value }))
vi.mock('./scheduled-taskgraph-audit-child-fence', async importOriginal => ({
  ...await importOriginal<typeof import('./scheduled-taskgraph-audit-child-fence')>(),
  lockScheduledTaskGraphAuditChildFence: mocks.childFence,
}))
vi.mock('./scheduled-taskgraph-audit-prepare-source', () => ({ validateScheduledTaskGraphAuditPrepareSource: mocks.auditPrepareSource }))
vi.mock('./scheduled-taskgraph-pipeline-checkpoint', () => ({ scheduledAutomationSnapshotDigest: vi.fn(() => 'sha256:snapshot'),
  scheduledTaskGraphContinuationKey: vi.fn(() => 'scheduled-taskgraph:key') }))
vi.mock('./scheduled-taskgraph-run-service', () => ({ validateScheduledPrepareWaitIdentity: mocks.validateWait }))
vi.mock('./scheduled-taskgraph-completed-report-replay', () => ({ replayCompletedScheduledTaskGraphReport: mocks.completedReplay,
  replayCompletedScheduledTaskGraphAuditReport: mocks.auditCompletedReplay }))
vi.mock('./stages/gate', () => ({ runScheduledGate: mocks.policy }))
vi.mock('./scheduled-taskgraph-gate-service', () => ({ executeScheduledTaskGraphGate: mocks.executeGate }))

import { runScheduledTaskGraphActionRpc } from './scheduled-taskgraph-gate-runtime-rpc'

const snapshot = { schemaVersion: 'agent-harness.v2.scheduled-automation-snapshot.v1', targetRoles: ['Engineer'],
  targetLocations: ['Dublin'], minScore: 70, dailyCap: 1, requireApproval: false, autoApply: true }
const requestOwner = { userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1',
  rootAttemptCount: 2, turnLeaseOwnerId: 'root-lease', turnLeaseVersion: 4 }
const owner = { ...requestOwner, executionId: 'execution-1', executionAttemptCount: 5 }
const canonicalAuditOwner = { ...owner, turnLeaseOwnerId: 'root-lease-v2', turnLeaseVersion: requestOwner.turnLeaseVersion + 1 }
const claim = { schemaVersion: 'agent-harness.v2.scheduled-pipeline-claim.v1', key: 'scheduled-taskgraph:key', claimToken: 'private-claim', owner,
  claimedAt: '2026-10-23T10:00:00.000Z', leaseExpiresAt: '2026-10-23T10:01:00.000Z' }
const state = { nextStage: 'gate', scheduledTaskGraphClaim: claim,
  scheduledTaskGraphContinuation: { key: claim.key, owner } }
function auditStateWithOwners(claimOwner: unknown, continuationOwner: unknown = claimOwner) {
  return { nextStage: 'gate', scheduledTaskGraphClaim: { ...claim, owner: claimOwner },
    scheduledTaskGraphContinuation: { schemaVersion: 'agent-harness.v2.scheduled-pipeline-continuation.v1',
      key: claim.key, owner: continuationOwner, snapshotDigest: 'sha256:snapshot', graphRevision: 15, evidenceDigest: 'b'.repeat(64) } }
}
const attestation = { snapshotDigest: 'sha256:snapshot', scout: { candidateJobIds: ['job-1'] } }
const proof = { receipt: { proof: true } }
const job = { id: 'job-1', userId: owner.userId }
const packageRow = { userId: owner.userId, sessionId: owner.sessionId, jobId: job.id, package: {} }
const materials = [{ userId: owner.userId, sessionId: owner.sessionId, jobId: job.id, kind: 'resume', artifactRef: { artifactId: 'artifact-1' } }]
const loaded = { packages: [packageRow], materials }
const gateTask = { id: 'gate-1', sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
  parentTaskId: owner.rootTaskId, depth: 1, role: 'prepare', taskType: 'scheduled_taskgraph_gate', status: 'running',
  attemptCount: 2, leaseOwner: 'gate-lease', leaseExpiresAt: new Date(Date.now() + 60_000), interruptRequestedAt: null,
  closedAt: null, expectedOutputSchema: { schemaVersion: 'agent-harness.v2.subagent.result', role: 'prepare', taskType: 'scheduled_taskgraph_gate' },
  allowedActions: [] }
const rootTask = { id: owner.rootTaskId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
  parentTaskId: null, status: 'running', attemptCount: owner.rootAttemptCount, interruptRequestedAt: null, closedAt: null }
let queryIndex = 0
const tx = { $queryRaw: mocks.queryRaw, job: { findMany: mocks.jobs }, agentExecution: { updateMany: mocks.update } }
const databaseTurn = (status: string, leaseVersion = requestOwner.turnLeaseVersion, leaseOwnerId = requestOwner.turnLeaseOwnerId) => ({ id: owner.turnId, userId: owner.userId, sessionId: owner.sessionId, rootTaskId: owner.rootTaskId,
  source: 'automation', executionMode: 'canonical_task_graph', input: { automationRunMode: 'scheduled', scheduledAutomationSnapshot: snapshot },
  status, leaseOwnerId: status === 'in_progress' ? leaseOwnerId : null, leaseVersion,
  leaseExpiresAt: status === 'in_progress' ? new Date(Date.now() + 60_000) : null })

function configureAuditLock(auditState: unknown) {
  queryIndex = 0
  mocks.queryRaw.mockImplementation(async () => {
    const position = queryIndex++ % 5
    if (position === 0) return [{ id: owner.sessionId, status: 'active' }]
    if (position === 1) return [databaseTurn('waiting_for_dependency', canonicalAuditOwner.turnLeaseVersion)]
    if (position === 2) return [{ ...rootTask, status: 'waiting' }]
    if (position === 3) return [{ ...gateTask, status: 'completed' }]
    return [{ id: owner.executionId, status: 'running', attemptCount: owner.executionAttemptCount, checkpoint: 'gate', state: auditState }]
  })
}

function gateRequest() {
  return { action: 'gate' as const, owner: requestOwner, attestation, prepareProof: proof, gateTaskId: gateTask.id,
    gateLeaseOwnerId: 'gate-lease', gateAttemptCount: 2 }
}

function executeRequest() {
  const gateCompletionProof = { schemaVersion: 'agent-harness.v2.scheduled-taskgraph-gate-completion.v1', graphRevision: 15,
    prepareProof: proof, gate: { taskId: gateTask.id, attemptCount: 2, resultDigest: `sha256:${'a'.repeat(64)}`, completedEventRevision: 15 } }
  return { action: 'execute' as const, owner: requestOwner, attestation, prepareProof: proof, gateCompletionProof }
}

function auditExecuteRequest() {
  const prepareProof = { receipt: { owner: { executionId: owner.executionId, executionAttemptCount: owner.executionAttemptCount } } }
  const gateCompletionProof = { schemaVersion: 'agent-harness.v2.scheduled-taskgraph-gate-completion.v1', graphRevision: 15,
    prepareProof, gate: { taskId: gateTask.id, attemptCount: 2, resultDigest: `sha256:${'a'.repeat(64)}`, completedEventRevision: 15 } }
  return { action: 'scheduled_audit_execute' as const, owner: requestOwner, attestation, prepareProof, gateCompletionProof,
    auditActor: { taskId: 'audit-1', attemptCount: 2, leaseOwner: 'audit-worker-2' } }
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  queryIndex = 0
  mocks.turn.mockResolvedValue({ input: { automationRunMode: 'scheduled', scheduledAutomationSnapshot: snapshot } })
  mocks.active.mockResolvedValue(true)
  mocks.feature.mockResolvedValue(true)
  mocks.access.mockResolvedValue('enabled')
  mocks.entitlement.mockResolvedValue(true)
  mocks.aiConfig.mockResolvedValue({ resolvedKey: true })
  mocks.config.mockResolvedValue({ id: 'config-1' })
  mocks.resume.mockResolvedValue({ id: 'resume-1', name: 'Resume', content: {} })
  mocks.roles.mockResolvedValue([])
  mocks.isProof.mockResolvedValue(true)
  mocks.auditProof.mockResolvedValue(true)
  mocks.auditPrepareSource.mockResolvedValue(true)
  mocks.childFence.mockResolvedValue(true)
  mocks.loadInput.mockResolvedValue(loaded)
  mocks.buildCheckpoint.mockReturnValue({ checkpoint: { nextStage: 'gate' }, packages: [] })
  mocks.validateWait.mockResolvedValue(true)
  mocks.completedReplay.mockResolvedValue(null)
  mocks.auditCompletedReplay.mockResolvedValue(null)
  mocks.executeGate.mockResolvedValue({ status: 'question_required', kind: 'weak_cover_letter', jobIds: ['job-1'],
    candidateSetDigest: `sha256:${'b'.repeat(64)}`, allowedChoiceIds: ['continue', 'review', 'skip'] })
  mocks.jobs.mockResolvedValue([job])
  mocks.update.mockResolvedValue({ count: 1 })
  mocks.queryRaw.mockImplementation(async () => {
    const position = queryIndex++ % 5
    if (position === 0) return [{ id: owner.sessionId, status: 'active' }]
    if (position === 1) return [databaseTurn('waiting_for_tool')]
    if (position === 2) return [rootTask]
    if (position === 3) return [gateTask]
    return [{ id: owner.executionId, status: 'running', attemptCount: owner.executionAttemptCount, checkpoint: 'gate', state }]
  })
  mocks.transaction.mockImplementation(async (work: (client: unknown) => unknown) => await work(tx))
})

describe('scheduled TaskGraph Gate/Execute runtime RPC', () => {
  it('checks current account, feature, AI budget, and effective entitlement before renewal or model work', async () => {
    mocks.active.mockResolvedValue(false)
    const denied = await runScheduledTaskGraphActionRpc(gateRequest())
    expect(denied).toBeInstanceOf(Response)
    expect((denied as Response).status).toBe(403)
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.aiConfig).not.toHaveBeenCalled()
    expect(mocks.executeGate).not.toHaveBeenCalled()

    mocks.active.mockResolvedValue(true)
    mocks.access.mockResolvedValue('exhausted')
    const exhausted = await runScheduledTaskGraphActionRpc(gateRequest())
    expect((exhausted as Response).status).toBe(429)
    expect(mocks.transaction).not.toHaveBeenCalled()

    mocks.access.mockResolvedValue('enabled')
    mocks.entitlement.mockResolvedValue(false)
    const unentitled = await runScheduledTaskGraphActionRpc(gateRequest())
    expect((unentitled as Response).status).toBe(403)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('runs the bounded Gate against an exact child lease while the Root Turn is suspended under a newer lease version', async () => {
    mocks.queryRaw.mockImplementation(async () => {
      const position = queryIndex++ % 5
      if (position === 0) return [{ id: owner.sessionId, status: 'active' }]
      if (position === 1) return [databaseTurn('waiting_for_tool', requestOwner.turnLeaseVersion + 1)]
      if (position === 2) return [rootTask]
      if (position === 3) return [gateTask]
      return [{ id: owner.executionId, status: 'running', attemptCount: owner.executionAttemptCount, checkpoint: 'gate', state }]
    })
    const result = await runScheduledTaskGraphActionRpc(gateRequest())
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(200)
    const responseBody = await (result as Response).json()
    expect(responseBody).toMatchObject({ status: 'question_required', jobIds: ['job-1'] })
    expect(mocks.update).toHaveBeenCalledOnce()
    expect(mocks.executeGate).toHaveBeenCalledOnce()
    expect(mocks.executeGate.mock.calls[0]?.[0]).toMatchObject({ handoff: { checkpoint: { nextStage: 'gate' } }, priorChoices: [] })
    expect(JSON.stringify(responseBody)).not.toContain('private-claim')
  })

  it('reloads Gate materials before a short current-owner transaction', async () => {
    const events: string[] = []
    let transactionCallbackActive = false, inputLoads = 0
    mocks.loadInput.mockImplementation(async () => {
      expect(transactionCallbackActive).toBe(false)
      inputLoads += 1
      if (inputLoads === 2) events.push('fresh_input')
      return loaded
    })
    mocks.transaction.mockImplementation(async (work: (client: unknown) => unknown) => {
      if (inputLoads === 2) events.push('owner_recheck')
      transactionCallbackActive = true
      try { return await work(tx) } finally { transactionCallbackActive = false }
    })

    const result = await runScheduledTaskGraphActionRpc(gateRequest()) as Response

    expect(result.status).toBe(200)
    expect(inputLoads).toBe(2)
    expect(events).toEqual(['fresh_input', 'owner_recheck'])
  })

  it('projects a safe test-only owner assertion phase without exposing the thrown message', async () => {
    const secretMessage = 'private database detail and fixture identity'
    vi.stubEnv('NODE_ENV', 'test')
    try {
      mocks.queryRaw.mockImplementation(async () => {
        if (queryIndex >= 5) throw new Error(secretMessage)
        const position = queryIndex++ % 5
        if (position === 0) return [{ id: owner.sessionId, status: 'active' }]
        if (position === 1) return [databaseTurn('waiting_for_tool')]
        if (position === 2) return [rootTask]
        if (position === 3) return [gateTask]
        return [{ id: owner.executionId, status: 'running', attemptCount: owner.executionAttemptCount, checkpoint: 'gate', state }]
      })
      const result = await runScheduledTaskGraphActionRpc(gateRequest()) as Response
      const body = await result.json()
      expect(result.status).toBe(500)
      expect(body).toMatchObject({ status: 'blocked', errorCode: 'scheduled_pipeline_execution_failed',
        testDiagnostic: { phase: 'owner_assertion', errorClass: 'error' } })
      expect(JSON.stringify(body)).not.toContain(secretMessage)
      expect(mocks.executeGate).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('projects only a Prisma code and safe class in tests, with no production diagnostics', async () => {
    const secretMessage = 'private prisma detail and fixture identity'
    mocks.executeGate.mockRejectedValue(new Prisma.PrismaClientKnownRequestError(secretMessage,
      { code: 'P2002', clientVersion: 'test' }))
    vi.stubEnv('NODE_ENV', 'test')
    try {
      const testResult = await runScheduledTaskGraphActionRpc(gateRequest()) as Response
      const testBody = await testResult.json()
      expect(testResult.status).toBe(500)
      expect(testBody).toMatchObject({ testDiagnostic: {
        phase: 'gate_execution', errorClass: 'prisma_known_request_error', prismaCode: 'P2002' } })
      expect(JSON.stringify(testBody)).not.toContain(secretMessage)

      vi.stubEnv('NODE_ENV', 'production')
      queryIndex = 0
      const productionResult = await runScheduledTaskGraphActionRpc(gateRequest()) as Response
      const productionBody = await productionResult.json()
      expect(Object.keys(productionBody).sort()).toEqual(['errorCode', 'status'])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('projects built-in TypeError and only exact allowlisted Gate error literals', async () => {
    const secretMessage = 'private database password and fixture identity'
    mocks.executeGate.mockRejectedValueOnce(new TypeError('scheduled_taskgraph_gate_result_invalid'))
      .mockRejectedValueOnce(new TypeError(secretMessage))
    vi.stubEnv('NODE_ENV', 'test')
    try {
      const knownResult = await runScheduledTaskGraphActionRpc(gateRequest()) as Response
      const knownBody = await knownResult.json()
      expect(knownBody).toMatchObject({ testDiagnostic: { phase: 'gate_execution', errorClass: 'type_error',
        safeErrorCode: 'scheduled_taskgraph_gate_result_invalid' } })

      queryIndex = 0
      const secretResult = await runScheduledTaskGraphActionRpc(gateRequest()) as Response
      const secretBody = await secretResult.json()
      expect(secretBody.testDiagnostic).toMatchObject({ phase: 'gate_execution', errorClass: 'type_error' })
      expect(secretBody.testDiagnostic).not.toHaveProperty('safeErrorCode')
      expect(JSON.stringify(secretBody)).not.toContain(secretMessage)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('accepts the exact live child while a newer Root lease is active, without borrowing that lease', async () => {
    mocks.queryRaw.mockImplementation(async () => {
      const position = queryIndex++ % 5
      if (position === 0) return [{ id: owner.sessionId, status: 'active' }]
      if (position === 1) return [databaseTurn('in_progress', requestOwner.turnLeaseVersion + 1, 'root-lease-v2')]
      if (position === 2) return [rootTask]
      if (position === 3) return [gateTask]
      return [{ id: owner.executionId, status: 'running', attemptCount: owner.executionAttemptCount, checkpoint: 'gate', state }]
    })
    const result = await runScheduledTaskGraphActionRpc(gateRequest())
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(200)
    expect(mocks.executeGate).toHaveBeenCalledOnce()
  })

  it('rejects malformed or mismatched persisted Prepare wait identity before renewing the claim or invoking Gate', async () => {
    for (const fixture of [
      { storedWait: null, suppliedWait: undefined },
      { storedWait: 'stored-prepare-wait', suppliedWait: 'different-prepare-wait' },
    ]) {
      queryIndex = 0
      mocks.queryRaw.mockImplementation(async () => {
        const position = queryIndex++ % 5
        if (position === 0) return [{ id: owner.sessionId, status: 'active' }]
        if (position === 1) return [databaseTurn('waiting_for_tool')]
        if (position === 2) return [rootTask]
        if (position === 3) return [gateTask]
        return [{ id: owner.executionId, status: 'running', attemptCount: owner.executionAttemptCount, checkpoint: 'gate',
          state: { ...state, scheduledTaskGraphScheduledWaitId: fixture.storedWait } }]
      })
      const request = { ...gateRequest(), ...(fixture.suppliedWait ? { scheduledWaitId: fixture.suppliedWait } : {}) }
      const rejected = await runScheduledTaskGraphActionRpc(request)
      expect(rejected).toBeInstanceOf(Response)
      expect((rejected as Response).status).toBe(409)
      expect(mocks.update).not.toHaveBeenCalled()
      expect(mocks.executeGate).not.toHaveBeenCalled()
    }
  })

  it('requires the live Root Turn lease before accepting a persisted Gate completion proof for Execute', async () => {
    const request = executeRequest()
    const denied = await runScheduledTaskGraphActionRpc(request)
    expect(denied).toBeInstanceOf(Response)
    expect((denied as Response).status).toBe(409)
    expect(mocks.executeGate).not.toHaveBeenCalled()

    queryIndex = 0
    mocks.queryRaw.mockImplementation(async () => {
      const position = queryIndex++ % 5
      if (position === 0) return [{ id: owner.sessionId, status: 'active' }]
      if (position === 1) return [databaseTurn('in_progress')]
      if (position === 2) return [rootTask]
      if (position === 3) return [{ ...gateTask, status: 'completed' }]
      return [{ id: owner.executionId, status: 'running', attemptCount: owner.executionAttemptCount, checkpoint: 'gate', state }]
    })
    const accepted = await runScheduledTaskGraphActionRpc(request)
    expect(accepted).toMatchObject({ kind: 'execute', request: { action: 'execute', gateCompletionProof: request.gateCompletionProof } })
  })

  it('returns a completed replay before the running-only Execute lock is attempted', async () => {
    const response = Response.json({ status: 'completed', report: { processed: 1 } })
    mocks.completedReplay.mockResolvedValueOnce(response)

    const result = await runScheduledTaskGraphActionRpc(executeRequest())

    expect(result).toBe(response)
    expect(mocks.completedReplay).toHaveBeenCalledWith(expect.objectContaining({ action: 'execute' }),
      { taskId: gateTask.id, attemptCount: 2 }, undefined)
    expect(mocks.queryRaw).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.executeGate).not.toHaveBeenCalled()
  })

  it('routes completed Audit replay through the live child actor before attempting root claim locks', async () => {
    const request = auditExecuteRequest()
    const response = Response.json({ status: 'completed', report: { processed: 1 } })
    mocks.auditCompletedReplay.mockResolvedValueOnce(response)

    const result = await runScheduledTaskGraphActionRpc(request)

    expect(result).toBe(response)
    expect(mocks.auditCompletedReplay).toHaveBeenCalledWith(request,
      { taskId: gateTask.id, attemptCount: 2 }, undefined)
    expect(mocks.completedReplay).not.toHaveBeenCalled()
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.queryRaw).not.toHaveBeenCalled()
  })

  it('authorizes an exact Audit actor with the persisted canonical Root owner after the request lease went stale', async () => {
    const request = auditExecuteRequest(), persisted = auditStateWithOwners(canonicalAuditOwner)
    configureAuditLock(persisted)

    const result = await runScheduledTaskGraphActionRpc(request)

    expect(result).toMatchObject({ kind: 'scheduled_audit_execute', request: { action: 'scheduled_audit_execute',
      owner: { ...requestOwner, turnLeaseOwnerId: canonicalAuditOwner.turnLeaseOwnerId,
        turnLeaseVersion: canonicalAuditOwner.turnLeaseVersion }, auditActor: request.auditActor } })
    if (!result || result instanceof Response || result.kind !== 'scheduled_audit_execute') throw new Error('audit_continuation_expected')
    expect(result.request.owner).toEqual({ ...requestOwner, turnLeaseOwnerId: canonicalAuditOwner.turnLeaseOwnerId,
      turnLeaseVersion: canonicalAuditOwner.turnLeaseVersion })
    expect(result.request.prepareProof).toBe(request.prepareProof)
    expect(result.request.gateCompletionProof).toBe(request.gateCompletionProof)
    expect(request.owner).toEqual(requestOwner)
    expect(mocks.auditProof).toHaveBeenCalledWith(expect.objectContaining({ owner: canonicalAuditOwner, auditActor: request.auditActor }), tx)
    expect(mocks.auditPrepareSource).toHaveBeenCalledWith(expect.objectContaining({ owner: canonicalAuditOwner }))
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.executeGate).not.toHaveBeenCalled()
  })

  it('rejects split or malformed persisted Audit owners without rewriting the claim or reactivating the Root', async () => {
    const splitOwner = { ...canonicalAuditOwner, turnLeaseVersion: canonicalAuditOwner.turnLeaseVersion + 1 }
    for (const persisted of [
      auditStateWithOwners(canonicalAuditOwner, splitOwner),
      auditStateWithOwners({ ...canonicalAuditOwner, unexpected: true }),
    ]) {
      configureAuditLock(persisted)
      const result = await runScheduledTaskGraphActionRpc(auditExecuteRequest())
      expect(result).toBeInstanceOf(Response)
      expect((result as Response).status).toBe(409)
      expect(mocks.auditProof).not.toHaveBeenCalled()
      expect(mocks.auditPrepareSource).not.toHaveBeenCalled()
      expect(mocks.update).not.toHaveBeenCalled()
      expect(mocks.executeGate).not.toHaveBeenCalled()
    }
  })
})
