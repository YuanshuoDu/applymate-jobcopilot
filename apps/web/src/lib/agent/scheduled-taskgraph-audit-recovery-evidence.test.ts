import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import type { ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import { validateScheduledTaskGraphAuditRecoveryEvidence } from './scheduled-taskgraph-audit-recovery-evidence'

const owner: ScheduledTaskGraphPipelineOwner = { userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1',
  rootAttemptCount: 2, turnLeaseOwnerId: 'worker-1', turnLeaseVersion: 3, executionId: 'execution-1', executionAttemptCount: 0 }
const source = { sourceEventId: 'candidate-event-1', stepId: 'candidate-step-4', ordinal: 4 }
const sourceCursor = '10'
const markerFor = (id = 'recovery-step-1', ordinal = 5, cursor = '11', recoveryCursor = 1, predecessorStepId = source.stepId) => ({
  schemaVersion: 'agent-harness.v2.scheduled-pipeline-recovery-step.v1', kind: 'scheduled_pipeline_recovery',
  owner: { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId },
  rootAttemptCount: owner.rootAttemptCount, sourceEventId: source.sourceEventId, sourceStepId: source.stepId,
  sourceStepOrdinal: source.ordinal, sourceInputThroughSequence: sourceCursor, recoveryStepId: id, recoveryCursor,
  predecessorStepId, inputThroughSequence: cursor,
})
function recoveryStep(status: string, options: Readonly<{ errorCode?: string | null; decimal?: boolean; id?: string; ordinal?: number;
  cursor?: string; recoveryCursor?: number; predecessorStepId?: string }> = {}) {
  const id = options.id ?? 'recovery-step-1', ordinal = options.ordinal ?? 5, cursor = options.cursor ?? '11'
  const marker = markerFor(id, ordinal, cursor, options.recoveryCursor, options.predecessorStepId)
  return { id, taskId: owner.rootTaskId, ordinal, attempt: 1, status, errorCode: options.errorCode ?? null,
    inputThroughSequence: BigInt(cursor), consumedInputIds: [], modelProfileSnapshot: { provider: 'fixture', scheduledPipelineRecoveryStep: marker },
    inputTokens: 0, outputTokens: 0, estimatedCostUsd: options.decimal ? new Prisma.Decimal(0) : 0, marker }
}
function lifecycle(step: ReturnType<typeof recoveryStep>, completion?: Record<string, unknown>) {
  const events = [{ id: `${step.id}-start`, taskId: owner.rootTaskId, itemId: null, type: 'step.started', actor: 'orchestrator',
    correlationId: step.id, idempotencyKey: `turn:${owner.turnId}:event:step-started:${step.id}`,
    payload: { stepId: step.id, ordinal: step.ordinal, taskId: owner.rootTaskId, scheduledPipelineRecoveryStep: step.marker } }]
  if (completion) events.push({ id: `${step.id}-complete`, taskId: owner.rootTaskId, itemId: null, type: 'step.completed', actor: 'orchestrator',
    correlationId: step.id, idempotencyKey: `turn:${owner.turnId}:event:step-completed:${step.id}`, payload: completion } as typeof events[number])
  return events
}
function completedPayload(step: ReturnType<typeof recoveryStep>, status: string, extra: Record<string, unknown> = {}) {
  return { stepId: step.id, status, taskId: owner.rootTaskId, ...extra }
}
function auditTask(attemptCount = 2) { return { id: 'audit-1', parentTaskId: owner.rootTaskId, rootTaskId: owner.rootTaskId,
  sessionId: owner.sessionId, turnId: owner.turnId, depth: 1, role: 'auditor', taskType: 'scheduled_taskgraph_audit',
  maxAttempts: 3, attemptCount, session: { userId: owner.userId } } }
function gateTask() { return { id: 'gate-1', parentTaskId: owner.rootTaskId, rootTaskId: owner.rootTaskId,
  sessionId: owner.sessionId, turnId: owner.turnId, depth: 1, role: 'prepare', taskType: 'scheduled_taskgraph_gate',
  maxAttempts: 3, session: { userId: owner.userId } } }
function auditWait(stepId: string, id = 'audit-wait-1') { return { id, userId: owner.userId, sessionId: owner.sessionId,
  turnId: owner.turnId, parentTaskId: owner.rootTaskId, stepId, idempotencyKey: auditWaitKey('audit-1', stepId, 1),
  targetTaskIds: ['audit-1'], mode: 'all', status: 'waiting', matchedTaskIds: [],
  result: { outcome: { status: 'waiting' }, request: { targetTaskIds: ['audit-1'], mode: 'all', timeoutMs: 86_400_000 } } }
}
function gateWait(stepId: string) { const digest = createHash('sha256').update(JSON.stringify(['gate-1', stepId, 1]), 'utf8').digest('hex')
  return { id: 'gate-ready-1', userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
    parentTaskId: owner.rootTaskId, stepId, idempotencyKey: `scheduled-gate-wait:${digest}`, targetTaskIds: ['gate-1'],
    mode: 'any', status: 'ready', matchedTaskIds: ['gate-1'], result: { request: { targetTaskIds: ['gate-1'], mode: 'any',
      timeoutMs: 86_400_000, scheduledGate: { gateTaskId: 'gate-1', requestAttemptCount: 1 } } } }
}
function gateBinding() { return { schemaVersion: 'agent-harness.v2.scheduled-gate-choice-wait.v1', owner: {
    userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
    rootAttemptCount: owner.rootAttemptCount, executionId: owner.executionId, executionAttemptCount: owner.executionAttemptCount },
  continuationKey: `scheduled-taskgraph:sha256:${'a'.repeat(64)}`, snapshotDigest: `sha256:${'b'.repeat(64)}`,
  evidenceDigest: 'c'.repeat(64), checkpointDigest: 'd'.repeat(64), analyzeGraphRevision: 9, graphRevision: 10,
  gateTaskId: 'gate-1', gateAttempt: 1, kind: 'weak_cover_letter', jobIds: ['job-1'], allowedChoiceIds: ['continue', 'review', 'skip'] }
}
function choiceItem(status: 'started' | 'completed' = 'started') {
  const binding = gateBinding(), waitId = `agent-question:${owner.turnId}:gate:${createHash('sha256').update(JSON.stringify(binding), 'utf8').digest('hex')}`
  return { id: `agent-wait:question:${waitId}`, stepId: 'recovery-step-1', taskId: owner.rootTaskId, type: 'question', status,
    content: { waitKind: 'question', questionId: waitId, toolCallId: null, stage: 'scheduled_gate', question: 'Review this result?',
      options: [{ label: 'Continue with current materials', value: 'continue' }, { label: 'Place for review', value: 'review' },
        { label: 'Skip', value: 'skip' }], answer: status === 'completed' ? 'continue' : null,
      answerAvailable: status === 'completed', scheduledGateChoiceBinding: binding,
      ...(status === 'completed' ? { answeredAt: '2026-10-25T12:00:00.000Z' } : {}) } }
}
function auditWaitKey(taskId: string, stepId: string, attempt: number) { const digest = createHash('sha256')
  .update(JSON.stringify([taskId, stepId, attempt]), 'utf8').digest('hex'); return `scheduled-audit-wait:${digest}` }
function fixture(options: Readonly<{ steps?: readonly Record<string, unknown>[]; events?: readonly Record<string, unknown>[];
  items?: readonly Record<string, unknown>[]; waits?: readonly Record<string, unknown>[]; tasks?: readonly Record<string, unknown>[] }> = {}) {
  const steps = options.steps ?? [], events = options.events ?? [], items = options.items ?? [], waits = options.waits ?? [], tasks = options.tasks ?? []
  const reader = { agentStep: { findMany: vi.fn(async () => steps) }, agentEvent: { findMany: vi.fn(async () => events) },
    agentItem: { findMany: vi.fn(async () => items) }, agentWaitCondition: { findMany: vi.fn(async () => waits) },
    subAgentTask: { findMany: vi.fn(async () => tasks) } } as unknown as Prisma.TransactionClient
  return { reader }
}
function validate(reader: Prisma.TransactionClient, fields: Partial<{ owner: ScheduledTaskGraphPipelineOwner; rootAttemptCount: number }> = {}) {
  return validateScheduledTaskGraphAuditRecoveryEvidence({ reader, owner: fields.owner ?? owner, source,
    sourceInputThroughSequence: sourceCursor, rootAttemptCount: fields.rootAttemptCount ?? owner.rootAttemptCount })
}

describe('scheduled TaskGraph Audit recovery evidence', () => {
  it('accepts an empty recovery tail before the root parks', async () => {
    const f = fixture()
    await expect(validate(f.reader)).resolves.toBe(true)
    expect(f.reader.agentStep.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { sessionId: owner.sessionId, turnId: owner.turnId, taskId: owner.rootTaskId, ordinal: { gt: source.ordinal } },
    }))
  })

  it('accepts a historical Audit wait after the child has advanced to attempt two', async () => {
    const step = recoveryStep('waiting_for_tool', { decimal: true })
    const wait = auditWait(step.id)
    const f = fixture({ steps: [step], events: lifecycle(step, completedPayload(step, 'waiting_for_dependency', { waitId: wait.id })),
      waits: [wait], tasks: [auditTask(2)] })
    await expect(validate(f.reader)).resolves.toBe(true)
  })

  it('uses the completion waitId when Gate-ready and Audit-pending waits share one Step', async () => {
    const step = recoveryStep('waiting_for_tool'), gate = gateWait(step.id), audit = auditWait(step.id)
    const f = fixture({ steps: [step], events: lifecycle(step, completedPayload(step, 'waiting_for_dependency', { waitId: audit.id })),
      waits: [gate, audit], tasks: [gateTask(), auditTask()] })
    await expect(validate(f.reader)).resolves.toBe(true)
    const reversed = fixture({ steps: [step], events: lifecycle(step, completedPayload(step, 'waiting_for_dependency', { waitId: audit.id })),
      waits: [audit, gate], tasks: [gateTask(), auditTask()] })
    await expect(validate(reversed.reader)).resolves.toBe(true)
  })

  it('validates a chained Gate/Audit wait followed by the exact no-wait blocker receipt', async () => {
    const first = recoveryStep('waiting_for_tool'), second = recoveryStep('waiting_for_tool', { id: 'recovery-step-2', ordinal: 8,
      cursor: '12', recoveryCursor: 2, predecessorStepId: first.id, errorCode: 'scheduled_audit_completion_unverified' })
    const gate = gateWait(first.id), audit = auditWait(first.id)
    const f = fixture({ steps: [first, second], events: [
      ...lifecycle(first, completedPayload(first, 'waiting_for_dependency', { waitId: audit.id })),
      ...lifecycle(second, completedPayload(second, 'waiting_for_dependency', { errorCode: second.errorCode! })),
    ], waits: [gate, audit], tasks: [gateTask(), auditTask(2)] })
    await expect(validate(f.reader)).resolves.toBe(true)
  })

  it('rejects a missing wait receipt or a wait owned by another root', async () => {
    const step = recoveryStep('waiting_for_tool'), wait = auditWait(step.id)
    const missing = fixture({ steps: [step], events: lifecycle(step, completedPayload(step, 'waiting_for_dependency', { waitId: 'not-this-row' })),
      waits: [wait], tasks: [auditTask()] })
    await expect(validate(missing.reader)).resolves.toBe(false)
    const foreign = fixture({ steps: [step], events: lifecycle(step, completedPayload(step, 'waiting_for_dependency', { waitId: wait.id })),
      waits: [{ ...wait, parentTaskId: 'foreign-root' }], tasks: [auditTask()] })
    await expect(validate(foreign.reader)).resolves.toBe(false)
  })

  it.each([
    ['wrong idempotency key', { idempotencyKey: 'scheduled-audit-wait:wrong' }],
    ['wrong wait mode', { mode: 'any' }],
    ['wrong target task', { targetTaskIds: ['other-audit'] }],
    ['wrong matched task set', { status: 'ready', matchedTaskIds: [] }],
  ] as const)('rejects an Audit wait with %s', async (_label, change) => {
    const step = recoveryStep('waiting_for_tool'), wait = { ...auditWait(step.id), ...change }
    const f = fixture({ steps: [step], events: lifecycle(step, completedPayload(step, 'waiting_for_dependency', { waitId: wait.id })),
      waits: [wait], tasks: [auditTask()] })
    await expect(validate(f.reader)).resolves.toBe(false)
  })

  it('accepts the exact pending scheduled Gate question on a waiting_for_user Step', async () => {
    const step = recoveryStep('waiting_for_user'), item = choiceItem()
    const f = fixture({ steps: [step], events: lifecycle(step, completedPayload(step, 'waiting_for_user')),
      items: [item], tasks: [gateTask()] })
    await expect(validate(f.reader)).resolves.toBe(true)
  })

  it('accepts an answered scheduled Gate question with the exact allowed choice', async () => {
    const step = recoveryStep('waiting_for_user'), item = choiceItem('completed')
    const f = fixture({ steps: [step], events: lifecycle(step, completedPayload(step, 'waiting_for_user')),
      items: [item], tasks: [gateTask()] })
    await expect(validate(f.reader)).resolves.toBe(true)
  })

  it('rejects malformed Gate questions and malformed recovery authority', async () => {
    const step = recoveryStep('waiting_for_user'), item = choiceItem()
    const badItem = { ...item, content: { ...item.content, stage: 'scheduled_prepare' } }
    const malformed = fixture({ steps: [step], events: lifecycle(step, completedPayload(step, 'waiting_for_user')),
      items: [badItem], tasks: [gateTask()] })
    await expect(validate(malformed.reader)).resolves.toBe(false)
    const changedMarker = recoveryStep('completed')
    changedMarker.marker.owner.rootTaskId = 'foreign-root'
    const badMarker = { ...changedMarker, modelProfileSnapshot: { scheduledPipelineRecoveryStep: changedMarker.marker } }
    const foreign = fixture({ steps: [badMarker], events: lifecycle(changedMarker, completedPayload(changedMarker, 'completed')) })
    await expect(validate(foreign.reader)).resolves.toBe(false)
    await expect(validate(fixture().reader, { rootAttemptCount: owner.rootAttemptCount + 1 })).resolves.toBe(false)
  })

  it('rejects a Gate question bound to a different execution identity', async () => {
    const step = recoveryStep('waiting_for_user'), binding = { ...gateBinding(), owner: {
      ...gateBinding().owner, executionId: 'foreign-execution' } }
    const waitId = `agent-question:${owner.turnId}:gate:${createHash('sha256').update(JSON.stringify(binding), 'utf8').digest('hex')}`
    const item = choiceItem(), foreignItem = { ...item, id: `agent-wait:question:${waitId}`, content: {
      ...item.content, questionId: waitId, scheduledGateChoiceBinding: binding } }
    const f = fixture({ steps: [step], events: lifecycle(step, completedPayload(step, 'waiting_for_user')),
      items: [foreignItem], tasks: [gateTask()] })
    await expect(validate(f.reader)).resolves.toBe(false)
  })

  it('rejects model, tool, replan, and non-question item receipts', async () => {
    const step = recoveryStep('completed'), base = lifecycle(step, completedPayload(step, 'completed'))
    for (const event of ['model.started', 'tool_call.started', 'final.rejected']) {
      const f = fixture({ steps: [step], events: [...base, { id: `e-${event}`, type: event, correlationId: step.id }] })
      await expect(validate(f.reader)).resolves.toBe(false)
    }
    const withToolItem = fixture({ steps: [step], events: base, items: [{ id: 'tool-item', stepId: step.id,
      taskId: owner.rootTaskId, type: 'tool_call', status: 'completed', content: {} }] })
    await expect(validate(withToolItem.reader)).resolves.toBe(false)
  })

  it('accepts a genuine completion and an exact no-new-wait blocker', async () => {
    const completed = recoveryStep('completed')
    const done = fixture({ steps: [completed], events: lifecycle(completed, completedPayload(completed, 'completed')) })
    await expect(validate(done.reader)).resolves.toBe(true)
    const blocked = recoveryStep('waiting_for_tool', { errorCode: 'scheduled_audit_completion_unverified' })
    const noWait = fixture({ steps: [blocked], events: lifecycle(blocked, completedPayload(blocked, 'waiting_for_dependency',
      { errorCode: 'scheduled_audit_completion_unverified' })) })
    await expect(validate(noWait.reader)).resolves.toBe(true)
  })
})
