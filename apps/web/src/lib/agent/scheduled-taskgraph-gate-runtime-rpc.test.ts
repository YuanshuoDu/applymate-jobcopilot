import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'
import { AgentExecutionCancelledError } from './execution-control'
import { createAnalyzeSourceChangedErrorWithClaims } from './stages/analyze-model-input'
import { isScheduledTaskGraphGateSourceChangedError, isScheduledTaskGraphGateSourceProofInvalidError } from './scheduled-taskgraph-gate-source'
import { readScheduledTaskGraphGateMaterialDriftProof } from './scheduled-taskgraph-gate-material-drift'
import { gateFailureDiagnostic } from './scheduled-taskgraph-pipeline-request'

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(), queryRaw: vi.fn(), jobs: vi.fn(), update: vi.fn(), turn: vi.fn(), config: vi.fn(), resume: vi.fn(),
  active: vi.fn(), feature: vi.fn(), access: vi.fn(), entitlement: vi.fn(), aiConfig: vi.fn(), roles: vi.fn(),
  isProof: vi.fn(), auditProof: vi.fn(), auditPrepareSource: vi.fn(), loadInput: vi.fn(), buildCheckpoint: vi.fn(), validateWait: vi.fn(), executeGate: vi.fn(),
  policy: vi.fn(), completedReplay: vi.fn(), auditCompletedReplay: vi.fn(),
  childFence: vi.fn(), sourceFence: vi.fn(), sourceValidation: vi.fn(), sourceTerminal: vi.fn(),
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
vi.mock('./scheduled-taskgraph-gate-source', async importOriginal => {
  const actual = await importOriginal<typeof import('./scheduled-taskgraph-gate-source')>()
  return { ...actual, acquireScheduledTaskGraphGateSourceFence: mocks.sourceFence,
    assertScheduledTaskGraphGateSourcesCurrent: mocks.sourceValidation,
    createScheduledTaskGraphGateOwnerFence: (locked: Parameters<typeof actual.createScheduledTaskGraphGateOwnerFence>[0],
      gateTaskId: Parameters<typeof actual.createScheduledTaskGraphGateOwnerFence>[1],
      assertCurrent: Parameters<typeof actual.createScheduledTaskGraphGateOwnerFence>[2]) => ({
      ...actual.createScheduledTaskGraphGateOwnerFence(locked, gateTaskId, assertCurrent),
      sourceHooks: { acquireFence: mocks.sourceFence, validateSource: (tx: unknown, jobId: string) =>
        mocks.sourceValidation(tx, { owner: locked.owner, jobId }) },
    }) }
})
vi.mock('./scheduled-taskgraph-gate-source-terminal', async importOriginal => ({
  ...await importOriginal<typeof import('./scheduled-taskgraph-gate-source-terminal')>(),
  respondToScheduledTaskGraphGateActionFailure: mocks.sourceTerminal,
}))
vi.mock('./scheduled-taskgraph-gate-input', () => ({ isScheduledTaskGraphGateProofCurrent: mocks.isProof,
  isScheduledTaskGraphAuditChildGateProofCurrent: mocks.auditProof,
  loadScheduledTaskGraphGateInput: mocks.loadInput, inspectScheduledTaskGraphGateInput: async (...args: unknown[]) => {
    const loaded = await mocks.loadInput(...args)
    return loaded && typeof loaded === 'object' && 'kind' in loaded ? loaded : loaded ? { kind: 'valid', input: loaded } : { kind: 'invalid' }
  }, scheduledTaskGraphAnalyzeCheckpointForGate: (value: unknown) => value }))
vi.mock('./scheduled-taskgraph-audit-child-fence', async importOriginal => ({
  ...await importOriginal<typeof import('./scheduled-taskgraph-audit-child-fence')>(),
  lockScheduledTaskGraphAuditChildFence: mocks.childFence,
}))
vi.mock('./scheduled-taskgraph-audit-prepare-source', () => ({ validateScheduledTaskGraphAuditPrepareSource: mocks.auditPrepareSource }))
vi.mock('./scheduled-taskgraph-pipeline-checkpoint', () => ({ scheduledAutomationSnapshotDigest: vi.fn(() => `sha256:${'a'.repeat(64)}`),
  scheduledTaskGraphContinuationKey: vi.fn(() => 'scheduled-taskgraph:key') }))
vi.mock('./scheduled-taskgraph-run-service', () => ({ validateScheduledPrepareWaitIdentity: mocks.validateWait }))
vi.mock('./scheduled-taskgraph-completed-report-replay', () => ({ replayCompletedScheduledTaskGraphReport: mocks.completedReplay,
  replayCompletedScheduledTaskGraphAuditReport: mocks.auditCompletedReplay }))
vi.mock('./stages/gate', () => ({ runScheduledGate: mocks.policy }))
vi.mock('./scheduled-taskgraph-gate-service', () => ({ executeScheduledTaskGraphGate: mocks.executeGate }))

import { runScheduledTaskGraphActionRpc } from './scheduled-taskgraph-gate-runtime-rpc'
import { parseScheduledTaskGraphAttestation } from './scheduled-taskgraph-attestation-candidates'

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
const attestation = { schemaVersion: 'agent-harness.v2.scheduled-pipeline-attestation.v1', owner: requestOwner,
  snapshotDigest: `sha256:${'a'.repeat(64)}`, graphRevision: 15, scout: { taskId: 'scout-task', attemptCount: 1,
    status: 'completed', verification: 'passed', resultDigest: 'c'.repeat(64), candidateJobIds: ['job-1'],
    discoveryReceipt: { status: 'complete', taskId: 'scout-task', attemptCount: 1, completedCalls: 1,
      candidateCount: 1, providerFailures: 0, materializationFailures: 0, hasMore: false, receiptDigest: 'a'.repeat(64) } },
  analyst: { taskId: 'analyst-task', attemptCount: 1, status: 'completed', verification: 'passed', resultDigest: 'd'.repeat(64),
    dependsOnTaskIds: ['scout-task'], jobIds: ['job-1'] }, evidenceDigest: 'b'.repeat(64) }
const multiScoutAttestation = { schemaVersion: 'agent-harness.v2.scheduled-pipeline-attestation.v2', owner: requestOwner,
  snapshotDigest: `sha256:${'a'.repeat(64)}`, graphRevision: 16, scouts: ['a', 'b'].map((suffix, index) => ({ nodeKey: `scout-${suffix}`,
    taskId: `scout-task-${suffix}`, attemptCount: 1, status: 'completed', verification: 'passed', resultDigest: `${index + 1}`.repeat(64),
    nodeDigest: `${index + 3}`.repeat(64), evidenceDigest: `${index + 5}`.repeat(64), reportDigest: `${index + 7}`.repeat(64),
    candidateJobIds: index === 0 ? ['job-1', 'unselected-job'] : ['unselected-job'],
    discoveryReceipt: { status: 'complete', taskId: `scout-task-${suffix}`, attemptCount: 1, completedCalls: 1,
      candidateCount: index === 0 ? 2 : 1, providerFailures: 0, materializationFailures: 0, hasMore: false,
      receiptDigest: (index === 0 ? '9' : 'a').repeat(64) } })), candidateUnionJobIds: ['job-1', 'unselected-job'],
  analyst: { nodeKey: 'analysis', taskId: 'analyst-task-multi', attemptCount: 1, status: 'completed', verification: 'passed',
    resultDigest: 'c'.repeat(64), nodeDigest: 'd'.repeat(64), evidenceDigest: 'e'.repeat(64), reportDigest: 'f'.repeat(64),
    dependsOnTaskIds: ['scout-task-a', 'scout-task-b'], jobIds: ['job-1'] }, evidenceDigest: 'a'.repeat(64) }
const proof = { receipt: { proof: true } }
const analysisFenceAt = '2026-10-20T09:00:00.000Z'
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

function configureGateLock(options: {
  turn?: ReturnType<typeof databaseTurn>
  root?: Record<string, unknown>
  gate?: Record<string, unknown>
  execution?: Record<string, unknown>
  waits?: unknown[]
  steps?: unknown[]
  resumeEvents?: unknown[]
  throwAfter?: number
  throwMessage?: string
} = {}) {
  const root = options.root ?? rootTask
  const responses: unknown[][] = [[{ id: owner.sessionId, status: 'active' }], [options.turn ?? databaseTurn('waiting_for_tool')],
    [{ status: root.status }]]
  if (root.status === 'waiting') responses.push(options.waits ?? [], options.steps ?? [])
  responses.push([root], [options.gate ?? gateTask], [options.execution ?? {
    id: owner.executionId, status: 'running', attemptCount: owner.executionAttemptCount, checkpoint: 'gate', state }])
  if (root.status === 'waiting') responses.push(options.resumeEvents ?? [])
  queryIndex = 0
  mocks.queryRaw.mockImplementation(async () => {
    if (options.throwAfter !== undefined && queryIndex >= options.throwAfter) {
      throw new Error(options.throwMessage ?? 'private database detail')
    }
    return responses[queryIndex++ % responses.length]
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
  mocks.sourceFence.mockResolvedValue(undefined)
  mocks.sourceValidation.mockResolvedValue(undefined)
  mocks.sourceTerminal.mockImplementation(async (input: { error: unknown; phase: 'owner_assertion' | 'gate_execution'; rethrowUnknown?: boolean }) => {
    if (isScheduledTaskGraphGateSourceProofInvalidError(input.error)) {
      return Response.json({ status: 'blocked', errorCode: 'scheduled_pipeline_attestation_invalid' }, { status: 409 })
    }
    if (isScheduledTaskGraphGateSourceChangedError(input.error)) {
      return Response.json({ status: 'blocked', errorCode: 'scheduled_pipeline_source_changed' }, { status: 409 })
    }
    if (input.rethrowUnknown) throw input.error
    const cancelled = input.error instanceof AgentExecutionCancelledError
    const response = { status: 'blocked', errorCode: cancelled ? 'scheduled_pipeline_turn_stale' : 'scheduled_pipeline_execution_failed' }
    return Response.json(process.env.NODE_ENV === 'test'
      ? { ...response, testDiagnostic: gateFailureDiagnostic(input.phase, input.error) } : response, { status: cancelled ? 409 : 500 })
  })
  mocks.loadInput.mockResolvedValue(loaded)
  mocks.buildCheckpoint.mockReturnValue({ checkpoint: { nextStage: 'gate' }, packages: [] })
  mocks.validateWait.mockResolvedValue(true)
  mocks.completedReplay.mockResolvedValue(null)
  mocks.auditCompletedReplay.mockResolvedValue(null)
  mocks.executeGate.mockResolvedValue({ status: 'question_required', kind: 'weak_cover_letter', jobIds: ['job-1'],
    candidateSetDigest: `sha256:${'b'.repeat(64)}`, allowedChoiceIds: ['continue', 'review', 'skip'] })
  mocks.jobs.mockResolvedValue([job])
  mocks.update.mockResolvedValue({ count: 1 })
  configureGateLock()
  mocks.transaction.mockImplementation(async (work: (client: unknown) => unknown) => await work(tx))
})

describe('scheduled TaskGraph Gate/Execute runtime RPC', () => {
  it('acquires the source fence before owner locks and validates sources before Gate proof loading', async () => {
    const events: string[] = []
    const originalQuery = mocks.queryRaw.getMockImplementation()!
    mocks.sourceFence.mockImplementation(async () => { events.push('source-fence') })
    mocks.sourceValidation.mockImplementation(async (_tx: unknown, input: { checkpoint?: unknown }) => {
      if (input.checkpoint !== undefined) events.push('initial-source-validation')
    })
    mocks.queryRaw.mockImplementation(async (...args: unknown[]) => {
      if (!events.includes('owner-lock')) events.push('owner-lock')
      return await originalQuery(...args)
    })
    mocks.loadInput.mockImplementation(async () => { events.push('proof-load'); return loaded })

    const result = await runScheduledTaskGraphActionRpc(gateRequest()) as Response

    expect(result.status).toBe(200)
    expect(events[0]).toBe('source-fence')
    expect(events[1]).toBe('owner-lock')
    expect(events.indexOf('initial-source-validation')).toBeGreaterThan(events.indexOf('owner-lock'))
    expect(events.indexOf('initial-source-validation')).toBeLessThan(events.indexOf('proof-load'))
    expect(mocks.sourceFence).toHaveBeenCalledWith(tx, owner.userId, owner.userId)
  })

  it('rolls back a Gate claim renewal when source validation fails after owner locks', async () => {
    const events: string[] = []
    const originalQuery = mocks.queryRaw.getMockImplementation()!
    let committedRenewals = 0
    mocks.sourceFence.mockImplementation(async () => { events.push('source-fence') })
    const sourceError = createAnalyzeSourceChangedErrorWithClaims([{ jobId: 'job-1', analysisFenceAt }])
    mocks.sourceValidation.mockRejectedValueOnce(sourceError)
    mocks.sourceTerminal.mockImplementation(async () => {
      expect(transactionActive).toBe(false)
      return Response.json({ status: 'blocked', errorCode: 'scheduled_pipeline_source_changed' }, { status: 409 })
    })
    mocks.queryRaw.mockImplementation(async (...args: unknown[]) => {
      events.push('owner-row-lock')
      return await originalQuery(...args)
    })
    let transactionActive = false
    mocks.transaction.mockImplementation(async (work: (client: unknown) => unknown) => {
      let stagedRenewals = 0
      const transactional = { ...tx, agentExecution: { updateMany: async (...args: unknown[]) => {
        const result = await mocks.update(...args) as { count: number }
        if (result.count === 1) stagedRenewals += 1
        return result
      } } }
      transactionActive = true
      try {
        const result = await work(transactional)
        committedRenewals += stagedRenewals
        return result
      } finally { transactionActive = false }
    })

    const result = await runScheduledTaskGraphActionRpc(gateRequest()) as Response
    const body = await result.json()

    expect(result.status).toBe(409)
    expect(body).toMatchObject({ status: 'blocked', errorCode: 'scheduled_pipeline_source_changed' })
    expect(events[0]).toBe('source-fence')
    expect(events[1]).toBe('owner-row-lock')
    expect(mocks.update).toHaveBeenCalledOnce()
    expect(committedRenewals).toBe(0)
    expect(mocks.sourceTerminal).toHaveBeenCalledOnce()
    expect(mocks.loadInput).not.toHaveBeenCalled()
    expect(mocks.executeGate).not.toHaveBeenCalled()
  })

  it('brands material-only drift inside the preflight transaction and reports only after rollback', async () => {
    const fingerprint = { version: 'agent-harness.v2.analyze-source-input.v1', digest: 'd'.repeat(64) }
    const driftState = { ...state, scoredJobs: [{ job: { id: 'job-1', userId: owner.userId }, score: 80 }],
      scheduledTaskGraphAnalyzeSourceFingerprints: { 'job-1': fingerprint } }
    configureGateLock({ execution: { id: owner.executionId, status: 'running', attemptCount: owner.executionAttemptCount,
      checkpoint: 'gate', state: driftState } })
    const evidence = { artifactDigest: `sha256:${'e'.repeat(64)}`, currentMaterialDigest: `sha256:${'f'.repeat(64)}` }
    mocks.loadInput.mockResolvedValue({ kind: 'material_source_drift', evidence })
    let transactionActive = false, committedRenewals = 0
    mocks.transaction.mockImplementation(async (work: (client: unknown) => unknown) => {
      let stagedRenewals = 0
      const transactional = { ...tx, agentExecution: { updateMany: async (...args: unknown[]) => {
        const result = await mocks.update(...args) as { count: number }
        if (result.count === 1) stagedRenewals += 1
        return result
      } } }
      transactionActive = true
      try {
        const result = await work(transactional)
        committedRenewals += stagedRenewals
        return result
      } finally { transactionActive = false }
    })
    mocks.sourceTerminal.mockImplementation(async (input: { error: unknown }) => {
      expect(transactionActive).toBe(false)
      expect((input.error as Error).message).toBe('scheduled_prepare_material_source_changed')
      expect(readScheduledTaskGraphGateMaterialDriftProof(input.error)).toMatchObject({ owner,
        gate: { taskId: gateTask.id, leaseOwnerId: 'gate-lease', attemptCount: 2 }, ...evidence })
      return Response.json({ status: 'blocked', errorCode: 'scheduled_prepare_material_source_changed' }, { status: 409 })
    })

    const result = await runScheduledTaskGraphActionRpc(gateRequest()) as Response

    expect(result.status).toBe(409)
    await expect(result.json()).resolves.toEqual({ status: 'blocked', errorCode: 'scheduled_prepare_material_source_changed' })
    expect(mocks.sourceTerminal).toHaveBeenCalledOnce()
    expect(mocks.update).toHaveBeenCalledOnce()
    expect(committedRenewals).toBe(0)
    expect(mocks.executeGate).not.toHaveBeenCalled()
  })

  it('preserves unrelated preflight transaction failures', async () => {
    const error = new Error('database unavailable')
    mocks.sourceValidation.mockRejectedValueOnce(error)

    await expect(runScheduledTaskGraphActionRpc(gateRequest())).rejects.toBe(error)
    expect(mocks.loadInput).not.toHaveBeenCalled()
    expect(mocks.executeGate).not.toHaveBeenCalled()
  })

  it('terminalizes source drift discovered after preflight only after rolling back the final Gate transaction', async () => {
    const sourceError = createAnalyzeSourceChangedErrorWithClaims([{ jobId: 'job-1', analysisFenceAt }])
    let activeTransactions = 0, committedReceipts = 0
    mocks.sourceValidation.mockResolvedValueOnce(undefined).mockRejectedValueOnce(sourceError)
    mocks.transaction.mockImplementation(async (work: (client: unknown) => unknown) => {
      let stagedReceipts = 0
      const transactional = { ...tx, stageReceipt: async () => { stagedReceipts += 1 } }
      activeTransactions += 1
      try {
        const result = await work(transactional)
        committedReceipts += stagedReceipts
        return result
      } finally { activeTransactions -= 1 }
    })
    mocks.sourceTerminal.mockImplementation(async (input: { error: unknown; locked: unknown; request: unknown }) => {
      expect(activeTransactions).toBe(0)
      expect(input.error).toBe(sourceError)
      expect(input.locked).toMatchObject({ owner, key: claim.key, claimToken: claim.claimToken })
      expect(input.request).toMatchObject({ gateTaskId: gateTask.id, gateLeaseOwnerId: 'gate-lease', gateAttemptCount: 2 })
      return Response.json({ status: 'blocked', errorCode: 'scheduled_pipeline_source_changed' }, { status: 409 })
    })
    mocks.executeGate.mockImplementation(async (input: { context: {
      scheduledTaskGraphOwnerFence: { assertCurrent(transaction: unknown): Promise<boolean>;
        sourceHooks: { acquireFence(transaction: unknown, userId: string): Promise<void>; validateSource(transaction: unknown, jobId: string): Promise<void> } }
    } }) => {
      await mocks.transaction(async (transaction: unknown) => {
        const fence = input.context.scheduledTaskGraphOwnerFence
        await fence.sourceHooks.acquireFence(transaction, owner.userId)
        if (!await fence.assertCurrent(transaction)) throw new AgentExecutionCancelledError()
        await (transaction as { stageReceipt(): Promise<void> }).stageReceipt()
        await fence.sourceHooks.validateSource(transaction, 'job-1')
      })
      return { status: 'completed' }
    })

    const response = await runScheduledTaskGraphActionRpc(gateRequest()) as Response

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ status: 'blocked', errorCode: 'scheduled_pipeline_source_changed' })
    expect(committedReceipts).toBe(0)
    expect(mocks.sourceTerminal).toHaveBeenCalledOnce()
  })

  it('keeps non-source final Gate transaction failures as execution failures', async () => {
    const error = new Error('database unavailable')
    let committedReceipts = 0
    mocks.sourceValidation.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(error)
    mocks.transaction.mockImplementation(async (work: (client: unknown) => unknown) => {
      let stagedReceipts = 0
      const result = await work({ ...tx, stageReceipt: async () => { stagedReceipts += 1 } })
      committedReceipts += stagedReceipts
      return result
    })
    mocks.executeGate.mockImplementation(async (input: { context: {
      scheduledTaskGraphOwnerFence: { assertCurrent(transaction: unknown): Promise<boolean>;
        sourceHooks: { acquireFence(transaction: unknown, userId: string): Promise<void>; validateSource(transaction: unknown, jobId: string): Promise<void> } }
    } }) => {
      await mocks.transaction(async (transaction: unknown) => {
        const fence = input.context.scheduledTaskGraphOwnerFence
        await fence.sourceHooks.acquireFence(transaction, owner.userId)
        if (!await fence.assertCurrent(transaction)) throw new AgentExecutionCancelledError()
        await (transaction as { stageReceipt(): Promise<void> }).stageReceipt()
        await fence.sourceHooks.validateSource(transaction, 'job-1')
      })
      return { status: 'completed' }
    })

    const response = await runScheduledTaskGraphActionRpc(gateRequest()) as Response

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({ status: 'blocked', errorCode: 'scheduled_pipeline_execution_failed',
      testDiagnostic: { phase: 'gate_execution', errorClass: 'error' } })
    expect(committedReceipts).toBe(0)
    expect(mocks.sourceTerminal).toHaveBeenCalledOnce()
    expect(mocks.sourceTerminal.mock.calls[0]?.[0]?.error).toBe(error)
  })

  it('provides live source hooks that fence before owner revalidation', async () => {
    const events: string[] = []
    const originalQuery = mocks.queryRaw.getMockImplementation()!
    mocks.sourceFence.mockImplementation(async () => { events.push('source-fence') })
    mocks.sourceValidation.mockImplementation(async (_tx: unknown, input: { checkpoint?: unknown }) => {
      if (input.checkpoint === undefined) events.push('live-source-validation')
    })
    mocks.queryRaw.mockImplementation(async (...args: unknown[]) => {
      events.push('owner-row-lock')
      return await originalQuery(...args)
    })
    mocks.executeGate.mockImplementation(async (input: { context: {
      scheduledTaskGraphOwnerFence: { assertCurrent(transaction: unknown): Promise<boolean>;
        sourceHooks: { acquireFence(transaction: unknown, userId: string): Promise<void>; validateSource(transaction: unknown, jobId: string): Promise<void> } }
    } }) => {
      await mocks.transaction(async (transaction: unknown) => {
        const fence = input.context.scheduledTaskGraphOwnerFence
        await fence.sourceHooks.acquireFence(transaction, owner.userId)
        if (!await fence.assertCurrent(transaction)) throw new AgentExecutionCancelledError()
        await fence.sourceHooks.validateSource(transaction, 'job-1')
      })
      return { status: 'completed' }
    })

    const result = await runScheduledTaskGraphActionRpc(gateRequest()) as Response

    expect(result.status).toBe(200)
    const finalFence = events.lastIndexOf('source-fence')
    const finalOwnerLock = events.lastIndexOf('owner-row-lock')
    const finalValidation = events.lastIndexOf('live-source-validation')
    expect(finalFence).toBeGreaterThanOrEqual(0)
    expect(finalOwnerLock).toBeGreaterThan(finalFence)
    expect(finalValidation).toBeGreaterThan(finalOwnerLock)
    expect(mocks.sourceValidation).toHaveBeenCalledWith(tx, { owner, jobId: 'job-1' })
  })

  it('keeps account and entitlement checks while allowing exhausted quality calls to degrade per package', async () => {
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
    expect((exhausted as Response).status).toBe(200)
    expect(mocks.executeGate).toHaveBeenCalledOnce()
    expect(typeof mocks.executeGate.mock.calls[0]?.[0]?.context?.scheduledGateQualityModelCall).toBe('function')

    mocks.access.mockResolvedValue('disabled')
    mocks.transaction.mockClear()
    const disabled = await runScheduledTaskGraphActionRpc(gateRequest())
    expect((disabled as Response).status).toBe(403)
    expect(mocks.transaction).not.toHaveBeenCalled()

    mocks.access.mockResolvedValue('enabled')
    mocks.entitlement.mockResolvedValue(false)
    const unentitled = await runScheduledTaskGraphActionRpc(gateRequest())
    expect((unentitled as Response).status).toBe(403)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('runs the bounded Gate against an exact child lease while the Root Turn is suspended under a newer lease version', async () => {
    configureGateLock({ turn: databaseTurn('waiting_for_tool', requestOwner.turnLeaseVersion + 1) })
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

  it('accepts a Gate child only after the exact Root dependency wait is fully persisted', async () => {
    const waitId = 'root-gate-wait', stepId = 'root-gate-step', requestAttemptCount = 0
    const digest = createHash('sha256').update(JSON.stringify([gateTask.id, stepId, requestAttemptCount]), 'utf8').digest('hex')
    const approvalSnapshot = { ...snapshot, requireApproval: true }, waitingTurn = databaseTurn('waiting_for_dependency')
    waitingTurn.input = { automationRunMode: 'scheduled', scheduledAutomationSnapshot: approvalSnapshot }
    mocks.turn.mockResolvedValue({ input: waitingTurn.input })
    const waitingRoot = { ...rootTask, status: 'waiting', result: { status: 'waiting_for_dependency',
      stepCount: 4, toolCallCount: 2, finalItemId: null, waitId } }
    configureGateLock({ turn: waitingTurn, root: waitingRoot,
      waits: [{ id: waitId, userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
        parentTaskId: owner.rootTaskId, stepId, idempotencyKey: `scheduled-gate-wait:${digest}`,
        targetTaskIds: [gateTask.id], mode: 'any', status: 'waiting', matchedTaskIds: [],
        result: { request: { targetTaskIds: [gateTask.id], mode: 'any', timeoutMs: 86_400_000,
          scheduledGate: { gateTaskId: gateTask.id, requestAttemptCount } } }, suspendedAt: new Date(), consumedAt: null }],
      steps: [{ id: stepId, taskId: owner.rootTaskId, attempt: 1, status: 'waiting_for_tool' }] })

    const request = { ...gateRequest(), scheduledWaitId: `agent-question:${owner.turnId}:canonical:${'a'.repeat(64)}` }
    const result = await runScheduledTaskGraphActionRpc(request) as Response

    expect(result.status).toBe(200)
    expect(mocks.executeGate).toHaveBeenCalledOnce()
    expect(mocks.isProof).toHaveBeenCalledWith(expect.objectContaining({ gateRootWait: expect.objectContaining({
      waitId, stepId, gateTaskId: gateTask.id, requestAttemptCount, owner,
      turn: expect.objectContaining({ id: owner.turnId, status: 'waiting_for_dependency', leaseVersion: owner.turnLeaseVersion }),
      root: { id: owner.rootTaskId, status: 'waiting', attemptCount: owner.rootAttemptCount, waitId },
    }) }), tx)
    expect(mocks.auditPrepareSource).toHaveBeenCalledWith(expect.objectContaining({ reader: tx,
      gateWait: expect.objectContaining({ waitId, stepId, gateTaskId: gateTask.id, owner: expect.objectContaining(owner) }) }))
    expect(mocks.validateWait).not.toHaveBeenCalled()
  })

  it('keeps the ordinary latest-Step validator for a no-approval Gate wait', async () => {
    const waitId = 'root-gate-wait', stepId = 'root-gate-step', requestAttemptCount = 0
    const digest = createHash('sha256').update(JSON.stringify([gateTask.id, stepId, requestAttemptCount]), 'utf8').digest('hex')
    const waitingRoot = { ...rootTask, status: 'waiting', result: { status: 'waiting_for_dependency',
      stepCount: 4, toolCallCount: 2, finalItemId: null, waitId } }
    configureGateLock({ turn: databaseTurn('waiting_for_dependency'), root: waitingRoot,
      waits: [{ id: waitId, userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
        parentTaskId: owner.rootTaskId, stepId, idempotencyKey: `scheduled-gate-wait:${digest}`,
        targetTaskIds: [gateTask.id], mode: 'any', status: 'waiting', matchedTaskIds: [],
        result: { request: { targetTaskIds: [gateTask.id], mode: 'any', timeoutMs: 86_400_000,
          scheduledGate: { gateTaskId: gateTask.id, requestAttemptCount } } }, suspendedAt: new Date(), consumedAt: null }],
      steps: [{ id: stepId, taskId: owner.rootTaskId, attempt: 1, status: 'waiting_for_tool' }] })
    mocks.validateWait.mockResolvedValue(false)

    const result = await runScheduledTaskGraphActionRpc(gateRequest()) as Response

    expect(result.status).toBe(409)
    expect(mocks.validateWait).toHaveBeenCalledOnce()
    expect(mocks.auditPrepareSource).not.toHaveBeenCalled()
  })

  it('fails closed when Root is waiting but the Turn lease handoff is partial', async () => {
    const waitingRoot = { ...rootTask, status: 'waiting', result: { status: 'waiting_for_dependency',
      stepCount: 4, toolCallCount: 2, finalItemId: null, waitId: 'root-gate-wait' } }
    configureGateLock({ turn: databaseTurn('in_progress', requestOwner.turnLeaseVersion + 1, 'live-root-lease'),
      root: waitingRoot })

    const result = await runScheduledTaskGraphActionRpc(gateRequest()) as Response

    expect(result.status).toBe(409)
    expect(mocks.executeGate).not.toHaveBeenCalled()
    expect(mocks.aiConfig).not.toHaveBeenCalled()
  })

  it('loads only the verified Analyst selection from a multi-Scout union', async () => {
    expect(parseScheduledTaskGraphAttestation(multiScoutAttestation)).not.toBeNull()
    const result = await runScheduledTaskGraphActionRpc({ ...gateRequest(), attestation: multiScoutAttestation }) as Response
    expect(result.status).toBe(200)
    expect(mocks.jobs).toHaveBeenCalledWith({ where: { userId: owner.userId, id: { in: ['job-1'] } } })
    expect(mocks.jobs.mock.calls[0]?.[0]).not.toMatchObject({ where: { id: { in: multiScoutAttestation.candidateUnionJobIds } } })
  })

  it('rejects a Gate review receipt when prepared material changes after preflight', async () => {
    const events: string[] = []
    let transactionCallbackActive = false, inputLoads = 0, receiptWrites = 0
    const changed = { ...loaded, materials: [{ ...materials[0]!, artifactRef: { artifactId: 'artifact-2' } }] }
    mocks.loadInput.mockImplementation(async (_input: unknown, reader: unknown) => {
      inputLoads += 1
      expect(transactionCallbackActive).toBe(true)
      expect(reader).toBe(tx)
      if (inputLoads === 1) events.push('preflight')
      if (inputLoads === 3) events.push('receipt_material_recheck')
      return inputLoads === 3 ? changed : loaded
    })
    mocks.transaction.mockImplementation(async (work: (client: unknown) => unknown) => {
      transactionCallbackActive = true
      try { return await work(tx) } finally { transactionCallbackActive = false }
    })
    mocks.executeGate.mockImplementation(async (input: { context: {
      scheduledTaskGraphOwnerFence: { gateTaskId: string; assertCurrent(transaction: unknown): Promise<boolean>;
        sourceHooks: { acquireFence(transaction: unknown, userId: string): Promise<void>; validateSource(transaction: unknown, jobId: string): Promise<void> } }
    } }) => {
      expect(input.context.scheduledTaskGraphOwnerFence.gateTaskId).toBe('gate-1')
      await mocks.transaction(async (transaction: unknown) => {
        await input.context.scheduledTaskGraphOwnerFence.sourceHooks.acquireFence(transaction, owner.userId)
        if (!await input.context.scheduledTaskGraphOwnerFence.assertCurrent(transaction)) {
          throw new AgentExecutionCancelledError()
        }
        await input.context.scheduledTaskGraphOwnerFence.sourceHooks.validateSource(transaction, 'job-1')
        receiptWrites += 1
      })
      return { status: 'completed' }
    })

    const result = await runScheduledTaskGraphActionRpc(gateRequest()) as Response

    expect(result.status).toBe(409)
    await expect(result.json()).resolves.toMatchObject({ status: 'blocked', errorCode: 'scheduled_pipeline_turn_stale' })
    expect(inputLoads).toBe(3)
    expect(events).toEqual(['preflight', 'receipt_material_recheck'])
    expect(receiptWrites).toBe(0)
    expect(mocks.sourceValidation).toHaveBeenCalledTimes(3)
  })

  it('reports source drift before a changed material loader can cancel final receipt replay', async () => {
    const sourceError = createAnalyzeSourceChangedErrorWithClaims([{ jobId: 'job-1', analysisFenceAt }])
    const changed = { ...loaded, materials: [{ ...materials[0]!, artifactRef: { artifactId: 'artifact-2' } }] }
    const events: string[] = []
    let sourceChecks = 0, inputLoads = 0, committedWrites = 0, transactionActive = false
    mocks.sourceValidation.mockImplementation(async () => {
      sourceChecks += 1
      events.push(`source-${sourceChecks}`)
      if (sourceChecks === 3) throw sourceError
    })
    mocks.loadInput.mockImplementation(async () => {
      inputLoads += 1
      events.push(`materials-${inputLoads}`)
      return inputLoads === 3 ? changed : loaded
    })
    mocks.transaction.mockImplementation(async (work: (client: unknown) => unknown) => {
      transactionActive = true
      let stagedWrites = 0
      try {
        const result = await work({ ...tx, stageReceipt: async () => { stagedWrites += 1 } })
        committedWrites += stagedWrites
        return result
      } finally { transactionActive = false }
    })
    mocks.sourceTerminal.mockImplementation(async input => {
      expect(transactionActive).toBe(false)
      expect(input.error).toBe(sourceError)
      return Response.json({ status: 'blocked', errorCode: 'scheduled_pipeline_source_changed' }, { status: 409 })
    })
    mocks.executeGate.mockImplementation(async (input: { context: {
      scheduledTaskGraphOwnerFence: { assertCurrent(transaction: unknown): Promise<boolean>;
        sourceHooks: { acquireFence(transaction: unknown, userId: string): Promise<void>; validateSource(transaction: unknown, jobId: string): Promise<void> } }
    } }) => {
      await mocks.transaction(async (transaction: unknown) => {
        const fence = input.context.scheduledTaskGraphOwnerFence
        await fence.sourceHooks.acquireFence(transaction, owner.userId)
        if (!await fence.assertCurrent(transaction)) throw new AgentExecutionCancelledError()
        await (transaction as { stageReceipt(): Promise<void> }).stageReceipt()
        await fence.sourceHooks.validateSource(transaction, 'job-1')
      })
      return { status: 'completed' }
    })

    const response = await runScheduledTaskGraphActionRpc(gateRequest()) as Response

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ status: 'blocked', errorCode: 'scheduled_pipeline_source_changed' })
    expect(events).toEqual(['source-1', 'materials-1', 'source-2', 'materials-2', 'source-3'])
    expect(inputLoads).toBe(2)
    expect(committedWrites).toBe(0)
    expect(mocks.sourceTerminal).toHaveBeenCalledOnce()
  })

  it('projects a safe test-only owner assertion phase without exposing the thrown message', async () => {
    const secretMessage = 'private database detail and fixture identity'
    vi.stubEnv('NODE_ENV', 'test')
    try {
      configureGateLock({ throwAfter: 6, throwMessage: secretMessage })
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
    configureGateLock({ turn: databaseTurn('in_progress', requestOwner.turnLeaseVersion + 1, 'root-lease-v2') })
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
      configureGateLock({ execution: { id: owner.executionId, status: 'running', attemptCount: owner.executionAttemptCount,
        checkpoint: 'gate', state: { ...state, scheduledTaskGraphScheduledWaitId: fixture.storedWait } } })
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
