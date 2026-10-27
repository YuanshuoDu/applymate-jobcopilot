import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { scheduledAutomationSnapshotDigest, type ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'

const mocks = vi.hoisted(() => ({ events: vi.fn(), sourceStep: vi.fn(), choice: vi.fn(), recoveryEvidence: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: {
  agentEvent: { findMany: mocks.events }, agentStep: { findFirst: mocks.sourceStep }, agentItem: { findFirst: mocks.choice },
} }))
vi.mock('./scheduled-taskgraph-audit-recovery-evidence', () => ({
  validateScheduledTaskGraphAuditRecoveryEvidence: mocks.recoveryEvidence,
}))

import { validateScheduledTaskGraphAuditPrepareSource } from './scheduled-taskgraph-audit-prepare-source'

const owner: ScheduledTaskGraphPipelineOwner = { userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1',
  rootAttemptCount: 3, turnLeaseOwnerId: 'worker-1', turnLeaseVersion: 8, executionId: 'execution-1', executionAttemptCount: 0 }
const stableOwner = { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
  rootAttemptCount: owner.rootAttemptCount, executionId: owner.executionId, executionAttemptCount: owner.executionAttemptCount }
const snapshot = { schemaVersion: 'agent-harness.v2.scheduled-automation-snapshot.v1', targetRoles: ['Engineer'], targetLocations: ['Dublin'],
  minScore: 70, dailyCap: 5, requireApproval: true, autoApply: false }
const receipt = { schemaVersion: 'agent-harness.v2.scheduled-taskgraph-continuation-receipt.v1', owner: { ...stableOwner,
  turnLeaseOwnerId: owner.turnLeaseOwnerId, turnLeaseVersion: owner.turnLeaseVersion },
  continuationKey: `scheduled-taskgraph:sha256:${'a'.repeat(64)}`, snapshotDigest: scheduledAutomationSnapshotDigest(snapshot),
  evidenceDigest: 'b'.repeat(64), checkpointDigest: 'c'.repeat(64), analyzeGraphRevision: 9, prepareScheduleRevision: 10 }
const sourceStepId = 'prepare-source-step', sourceStepOrdinal = 5
const candidateEvent = { id: 'candidate-event', type: 'native_verification.scheduled_candidate_staged', taskId: owner.rootTaskId,
  correlationId: sourceStepId, payload: { schemaVersion: 'agent-harness.v2.scheduled-pipeline-candidate.v2', sessionId: owner.sessionId,
    turnId: owner.turnId, rootTaskId: owner.rootTaskId, rootAttemptCount: owner.rootAttemptCount, finalStepId: sourceStepId,
    finalStepOrdinal: sourceStepOrdinal, stepAttempt: 1, candidateText: 'The tailored application is ready.', finishReason: 'completed',
    usage: { inputTokens: 37, outputTokens: 9, estimatedCostUsd: 0.018 } } }
const binding = choiceBinding(receipt), scheduledWaitId = choiceId(receipt)
const choiceItem = choiceItemFor(receipt, binding, scheduledWaitId)
const request = { owner, snapshot, proof: { receipt, completion: {}, result: {} }, scheduledWaitId }

function choiceBinding(value: typeof receipt) {
  return { schemaVersion: 'agent-harness.v2.scheduled-prepare-choice-wait.v1', owner: stableOwner, continuationKey: value.continuationKey,
    snapshotDigest: value.snapshotDigest, evidenceDigest: value.evidenceDigest, checkpointDigest: value.checkpointDigest,
    analyzeGraphRevision: value.analyzeGraphRevision, prepareScheduleRevision: value.prepareScheduleRevision,
    finalStepId: sourceStepId, finalStepOrdinal: sourceStepOrdinal, finalStepAttempt: 1 }
}
function choiceId(value: typeof receipt) {
  const values = [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.rootAttemptCount, owner.executionId,
    owner.executionAttemptCount, value.continuationKey, value.snapshotDigest, value.evidenceDigest, value.checkpointDigest,
    value.analyzeGraphRevision, value.prepareScheduleRevision, sourceStepId, sourceStepOrdinal, 1]
  return `agent-question:${owner.turnId}:canonical:${createHash('sha256').update(JSON.stringify(values), 'utf8').digest('hex')}`
}
function choiceItemFor(value: typeof receipt, binding: ReturnType<typeof choiceBinding>, waitId: string) {
  return { id: `agent-wait:question:${waitId}`, stepId: sourceStepId, taskId: owner.rootTaskId,
    type: 'question', status: 'completed', content: { waitKind: 'question', questionId: waitId, toolCallId: null,
      stage: 'scheduled_prepare', question: 'How should ApplyMate tailor your resume for this role?',
      options: [{ label: 'Apply AI changes', value: 'apply_ai_changes' }, { label: 'Keep my current resume', value: 'keep_resume' }],
      answer: 'apply_ai_changes', answerAvailable: true, scheduledPrepareChoiceBinding: binding, answeredAt: '2026-10-25T12:00:00.000Z' } }
}
function setup() {
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.events.mockImplementation((query: { where: Record<string, unknown> }) => {
    if (query.where.type === 'agent.plan.scheduled_prepare_binding') return Promise.resolve([{ payload: receipt }])
    if (query.where.type === 'native_verification.scheduled_candidate_staged') return Promise.resolve([candidateEvent])
    if (query.where.type === 'final.rejected') return Promise.resolve([])
    return Promise.resolve([])
  })
  mocks.sourceStep.mockResolvedValue({ id: sourceStepId, ordinal: sourceStepOrdinal, attempt: 1,
    status: 'waiting_for_user', inputThroughSequence: BigInt(9) })
  mocks.choice.mockResolvedValue(choiceItem)
  mocks.recoveryEvidence.mockResolvedValue(true)
}

describe('Audit-only historical Prepare source validation', () => {
  beforeEach(setup)

  it('retains the exact receipt and choice while delegating recovery-tail receipts', async () => {
    await expect(validateScheduledTaskGraphAuditPrepareSource(request)).resolves.toBe(true)
    expect(mocks.recoveryEvidence).toHaveBeenCalledWith(expect.objectContaining({ owner, source: {
      sourceEventId: candidateEvent.id, stepId: sourceStepId, ordinal: sourceStepOrdinal,
    }, sourceInputThroughSequence: '9', rootAttemptCount: owner.rootAttemptCount }))
  })

  it('accepts the exact v2 Prepare choice receipt and rejects a trailing continuation key', async () => {
    const v2Receipt = { ...receipt, continuationKey: `scheduled-taskgraph:v2:sha256:${'e'.repeat(64)}` }
    const v2Binding = choiceBinding(v2Receipt), v2WaitId = choiceId(v2Receipt)
    mocks.events.mockImplementation((query: { where: Record<string, unknown> }) => {
      if (query.where.type === 'agent.plan.scheduled_prepare_binding') return Promise.resolve([{ payload: v2Receipt }])
      if (query.where.type === 'native_verification.scheduled_candidate_staged') return Promise.resolve([candidateEvent])
      return Promise.resolve([])
    })
    mocks.choice.mockResolvedValue(choiceItemFor(v2Receipt, v2Binding, v2WaitId))
    await expect(validateScheduledTaskGraphAuditPrepareSource({ ...request,
      proof: { receipt: v2Receipt, completion: {}, result: {} }, scheduledWaitId: v2WaitId })).resolves.toBe(true)

    const malformed = { ...v2Receipt, continuationKey: `${v2Receipt.continuationKey}\n` }
    await expect(validateScheduledTaskGraphAuditPrepareSource({ ...request,
      proof: { receipt: malformed, completion: {}, result: {} }, scheduledWaitId: v2WaitId })).resolves.toBe(false)
  })

  it('rejects an invalid recovery tail or source replan receipt', async () => {
    mocks.recoveryEvidence.mockResolvedValue(false)
    await expect(validateScheduledTaskGraphAuditPrepareSource(request)).resolves.toBe(false)

    setup()
    mocks.events.mockImplementation((query: { where: Record<string, unknown> }) => {
      if (query.where.type === 'agent.plan.scheduled_prepare_binding') return Promise.resolve([{ payload: receipt }])
      if (query.where.type === 'native_verification.scheduled_candidate_staged') return Promise.resolve([candidateEvent])
      if (query.where.type === 'final.rejected') return Promise.resolve([{ id: 'rejected' }])
      return Promise.resolve([])
    })
    await expect(validateScheduledTaskGraphAuditPrepareSource(request)).resolves.toBe(false)
    expect(mocks.recoveryEvidence).not.toHaveBeenCalled()
  })

  it('requires the bound Prepare choice and matching root-attempt receipt', async () => {
    mocks.choice.mockResolvedValue(null)
    await expect(validateScheduledTaskGraphAuditPrepareSource(request)).resolves.toBe(false)
    expect(mocks.recoveryEvidence).not.toHaveBeenCalled()

    setup()
    await expect(validateScheduledTaskGraphAuditPrepareSource({ ...request,
      owner: { ...owner, rootAttemptCount: owner.rootAttemptCount + 1 } })).resolves.toBe(false)
    await expect(validateScheduledTaskGraphAuditPrepareSource({ ...request, scheduledWaitId: 'other-wait' })).resolves.toBe(false)
  })
})
