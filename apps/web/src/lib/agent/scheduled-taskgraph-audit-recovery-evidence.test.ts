import { createHash } from 'node:crypto'
import { AGENT_STREAM_SCHEMA_VERSION } from '@jobcopilot/agent-protocol'
import { Prisma } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import type { ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import { validateScheduledTaskGraphAuditRecoveryEvidence } from './scheduled-taskgraph-audit-recovery-evidence'

const SCHEDULED_AUDIT_TEMPLATE_ID = 'scheduled_audit'
const SCHEDULED_AUDIT_NODE_GOAL = 'Return the exact report from the authenticated scheduled Audit continuation after Gate completion.'
const SCHEDULED_AUDIT_NODE_CRITERIA = ['Continue the exact scheduled execution only after its canonical Gate proof is verified.',
  'Return only the fixed seven-field report without adding actions or interpreting historical counts.',
  'Never submit applications or invoke model or tool runtimes.']
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
  const events = [{ id: `${step.id}-start`, sessionId: owner.sessionId, turnId: owner.turnId, taskId: owner.rootTaskId, itemId: null, type: 'step.started', actor: 'orchestrator',
    correlationId: step.id, idempotencyKey: `turn:${owner.turnId}:event:step-started:${step.id}`,
    payload: { stepId: step.id, ordinal: step.ordinal, taskId: owner.rootTaskId, scheduledPipelineRecoveryStep: step.marker } }]
  if (completion) events.push({ id: `${step.id}-complete`, sessionId: owner.sessionId, turnId: owner.turnId, taskId: owner.rootTaskId, itemId: null, type: 'step.completed', actor: 'orchestrator',
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
function auditGraphContent() { return { schemaVersion: 'agent-harness.v2.task-graph', nodes: [
  { key: 'scout', templateId: 'scout', goal: 'Find evidence', successCriteria: ['Found evidence'], dependsOn: [], depth: 1,
    taskId: 'scout-child-1', verificationDisposition: 'legacy_unverified' },
  { key: 'analyst', templateId: 'analyst', goal: 'Review evidence', successCriteria: ['Reviewed evidence'], dependsOn: ['scout'], depth: 2,
    taskId: 'analyst-child-1', verificationDisposition: 'legacy_unverified' },
  { key: 'prepare', templateId: 'prepare', goal: 'Prepare the application', successCriteria: ['Preparation is complete'], dependsOn: ['analyst'], depth: 3,
    taskId: 'prepare-child-1', verificationDisposition: 'specialized' },
  { key: 'gate', templateId: 'gate', goal: 'Review the application', successCriteria: ['Review is complete'], dependsOn: ['prepare'], depth: 4,
    taskId: 'gate-1', verificationDisposition: 'specialized' },
  { key: SCHEDULED_AUDIT_TEMPLATE_ID, templateId: SCHEDULED_AUDIT_TEMPLATE_ID, goal: SCHEDULED_AUDIT_NODE_GOAL,
    successCriteria: SCHEDULED_AUDIT_NODE_CRITERIA, dependsOn: ['gate'], depth: 5,
    taskId: 'audit-1', verificationDisposition: 'specialized' },
] } }
function taskGraphId() { return `task-graph-${createHash('sha256').update(owner.rootTaskId).digest('hex')}` }
function auditGraphItem(stepId: string, revision = 7, content = auditGraphContent()) {
  return { id: taskGraphId(), sessionId: owner.sessionId, turnId: owner.turnId, stepId, taskId: owner.rootTaskId,
    type: 'task_graph', status: 'streaming', phase: null, revision, content }
}
function auditGraphProposal(stepId: string, revision = 6, content = auditGraphContent()) {
  const id = taskGraphId(), now = '2026-10-25T12:10:00.000Z'
  const item = { schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id, sessionId: owner.sessionId, turnId: owner.turnId,
    stepId, taskId: owner.rootTaskId, type: 'task_graph', status: 'streaming', phase: null, revision, content,
    startedAt: now, completedAt: null, createdAt: now, updatedAt: now }
  const payload = { kind: 'proposal', fingerprint: 'f'.repeat(64), revision,
    receipt: { status: 'accepted', revision, nodes: [{ key: SCHEDULED_AUDIT_TEMPLATE_ID, taskId: 'audit-1', status: 'queued' }],
      readyTaskIds: ['audit-1'] }, item, content }
  return { id: `${stepId}-proposal`, sessionId: owner.sessionId, turnId: owner.turnId, taskId: owner.rootTaskId,
    itemId: id, type: 'item.delta', actor: 'orchestrator', correlationId: owner.turnId, causationId: stepId,
    idempotencyKey: `${id}:proposal:${revision - 1}`, payload }
}
function auditWaitKey(taskId: string, stepId: string, attempt: number) { const digest = createHash('sha256')
  .update(JSON.stringify([taskId, stepId, attempt]), 'utf8').digest('hex'); return `scheduled-audit-wait:${digest}` }
function fixture(options: Readonly<{ steps?: readonly Record<string, unknown>[]; events?: readonly Record<string, unknown>[];
  items?: readonly Record<string, unknown>[]; waits?: readonly Record<string, unknown>[]; tasks?: readonly Record<string, unknown>[] }> = {}) {
  const steps = options.steps ?? [], events = options.events ?? [], items = options.items ?? [], waits = options.waits ?? [], tasks = options.tasks ?? []
  const reader = { agentStep: { findMany: vi.fn(async () => steps) }, agentEvent: { findMany: vi.fn(async (args?: unknown) => filterEvents(events, args)) },
    agentItem: { findMany: vi.fn(async () => items) }, agentWaitCondition: { findMany: vi.fn(async () => waits) },
    subAgentTask: { findMany: vi.fn(async () => tasks) } } as unknown as Prisma.TransactionClient
  return { reader }
}
function filterEvents(events: readonly Record<string, unknown>[], args: unknown) {
  const where = args && typeof args === 'object' ? (args as { where?: Record<string, unknown> }).where : undefined
  if (!where) return events
  return events.filter(event => Object.entries(where).every(([key, filter]) => {
    if (filter && typeof filter === 'object' && !Array.isArray(filter)) {
      const row = filter as Record<string, unknown>
      if (Array.isArray(row.in)) return row.in.includes(event[key])
      if (typeof row.startsWith === 'string') return typeof event[key] === 'string' && event[key].startsWith(row.startsWith)
    }
    return event[key] === filter
  }))
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
      const f = fixture({ steps: [step], events: [...base, { id: `e-${event}`, sessionId: owner.sessionId, turnId: owner.turnId, taskId: owner.rootTaskId, itemId: null, actor: 'orchestrator', type: event, correlationId: step.id }] })
      await expect(validate(f.reader)).resolves.toBe(false)
    }
    const withToolItem = fixture({ steps: [step], events: base, items: [{ id: 'tool-item', stepId: step.id,
      taskId: owner.rootTaskId, type: 'tool_call', status: 'completed', content: {} }] })
    await expect(validate(withToolItem.reader)).resolves.toBe(false)
  })

  it('accepts a streaming recovery Step after stripping its exact graph item', async () => {
    const step = recoveryStep('streaming'), content = auditGraphContent()
    const f = fixture({ steps: [step], events: [...lifecycle(step), auditGraphProposal(step.id, 6, content)],
      items: [auditGraphItem(step.id, 7, content)] })
    await expect(validate(f.reader)).resolves.toBe(true)
  })

  it('strips the exact graph item while retaining the scheduled Gate question', async () => {
    const step = recoveryStep('waiting_for_user'), question = choiceItem(), content = auditGraphContent()
    const f = fixture({ steps: [step], events: [...lifecycle(step, completedPayload(step, 'waiting_for_user')),
      auditGraphProposal(step.id, 6, content)], items: [question, auditGraphItem(step.id, 7, content)], tasks: [gateTask()] })
    await expect(validate(f.reader)).resolves.toBe(true)
  })

  it('requires a fresh R2 receipt after the singleton moves from R1', async () => {
    const first = recoveryStep('waiting_for_tool'), second = recoveryStep('waiting_for_tool', { id: 'recovery-step-2', ordinal: 8,
      cursor: '12', recoveryCursor: 2, predecessorStepId: first.id, errorCode: 'scheduled_audit_completion_unverified' })
    const content = auditGraphContent(), gate = gateWait(first.id), audit = auditWait(first.id)
    const events = [...lifecycle(first, completedPayload(first, 'waiting_for_dependency', { waitId: audit.id })),
      ...lifecycle(second, completedPayload(second, 'waiting_for_dependency', { errorCode: second.errorCode! })),
      auditGraphProposal(first.id, 6, content), auditGraphProposal(second.id, 7, content)]
    const current = fixture({ steps: [first, second], events, items: [auditGraphItem(second.id, 8, content)],
      waits: [gate, audit], tasks: [gateTask(), auditTask(2)] })
    await expect(validate(current.reader)).resolves.toBe(true)
    const staleOnly = fixture({ steps: [first, second], events: [...events.filter(event => !String(event.id).startsWith(`${second.id}-proposal`))],
      items: [auditGraphItem(second.id, 8, content)], waits: [gate, audit], tasks: [gateTask(), auditTask(2)] })
    await expect(validate(staleOnly.reader)).resolves.toBe(false)
  })

  it('rejects duplicate graph singleton rows', async () => {
    const step = recoveryStep('streaming'), content = auditGraphContent(), graph = auditGraphItem(step.id, 7, content)
    const f = fixture({ steps: [step], events: [...lifecycle(step), auditGraphProposal(step.id, 6, content)], items: [graph, { ...graph }] })
    await expect(validate(f.reader)).resolves.toBe(false)
  })

  it('does not remove an unrelated item when a verified graph item is present', async () => {
    const step = recoveryStep('waiting_for_user'), question = choiceItem(), content = auditGraphContent()
    const f = fixture({ steps: [step], events: [...lifecycle(step, completedPayload(step, 'waiting_for_user')),
      auditGraphProposal(step.id, 6, content)], items: [question, auditGraphItem(step.id, 7, content),
        { id: 'tool-item', stepId: step.id, taskId: owner.rootTaskId, type: 'tool_call', status: 'completed', content: {} }],
      tasks: [gateTask()] })
    await expect(validate(f.reader)).resolves.toBe(false)
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
