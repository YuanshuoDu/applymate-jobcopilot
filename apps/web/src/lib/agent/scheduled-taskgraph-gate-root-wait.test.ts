import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { SCHEDULED_GATE_REVIEW_MARKER_SCHEMA } from './approval/gate-replay'
import { lockScheduledTaskGraphRootAction, scheduledGateRootWaitWitnessMatches, scheduledGateWaitAttemptMatchesCurrentHistory } from './scheduled-taskgraph-gate-root-wait'

const owner = { userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1',
  rootAttemptCount: 2, turnLeaseOwnerId: 'old-root-lease', turnLeaseVersion: 4 }
const pipelineOwner = { ...owner, executionId: 'execution-1', executionAttemptCount: 0 }
const gateTaskId = 'gate-1', waitId = 'wait-1', stepId = 'step-1'
const rootResult = { status: 'waiting_for_dependency', stepCount: 8, toolCallCount: 4, finalItemId: null, waitId }
function waitRow(overrides: Record<string, unknown> = {}) {
  const requestAttemptCount = 0
  const digest = createHash('sha256').update(JSON.stringify([gateTaskId, stepId, requestAttemptCount]), 'utf8').digest('hex')
  return { id: waitId, userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
    parentTaskId: owner.rootTaskId, stepId, idempotencyKey: `scheduled-gate-wait:${digest}`,
    targetTaskIds: [gateTaskId], mode: 'any', status: 'waiting', matchedTaskIds: [],
    result: { request: { targetTaskIds: [gateTaskId], mode: 'any', timeoutMs: 86_400_000,
      scheduledGate: { gateTaskId, requestAttemptCount } } }, suspendedAt: new Date(), consumedAt: null, ...overrides }
}
function rootRow(overrides: Record<string, unknown> = {}) {
  return { id: owner.rootTaskId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
    parentTaskId: null, status: 'waiting', attemptCount: owner.rootAttemptCount, interruptRequestedAt: null,
    closedAt: null, result: rootResult, ...overrides }
}
function transaction(responses: unknown[], approvals: unknown[] = [], items: unknown[] = [], events: unknown[] = []) {
  const queryRaw = vi.fn(async () => responses.shift() ?? [])
  const approvalFindMany = vi.fn(async () => approvals)
  const itemFindMany = vi.fn(async () => items)
  const eventFindMany = vi.fn(async () => events)
  return { client: { $queryRaw: queryRaw, agentApproval: { findMany: approvalFindMany },
    agentItem: { findMany: itemFindMany }, agentEvent: { findMany: eventFindMany } } as unknown as Prisma.TransactionClient,
    queryRaw, approvalFindMany, itemFindMany, eventFindMany }
}
function approvalWitness() {
  const expiresAt = new Date(Date.now() + 60_000)
  const row = { id: 'approval-1', userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
    taskId: 'application-task-1', jobId: 'job-1', toolCallId: 'call-1', type: 'review_application', status: 'pending',
    title: 'Review application', body: 'Review materials', impact: { externalSubmission: false, jobId: 'job-1' },
    payload: { jobId: 'job-1', applicationTaskId: 'application-task-1',
      scheduledGateReview: { schemaVersion: SCHEDULED_GATE_REVIEW_MARKER_SCHEMA, gateTaskId } },
    scopeHash: 'scope-1', revision: 1, expiresAt, decidedAt: null, consumedAt: null }
  const item = { id: 'agent-wait:approval:approval-1', sessionId: owner.sessionId, turnId: owner.turnId,
    stepId: null, taskId: null, type: 'approval_request', status: 'started', revision: 0,
    content: { waitKind: 'approval', approvalId: row.id, toolCallId: row.toolCallId, action: row.type,
      title: row.title, body: row.body, impact: row.impact, scopeHash: row.scopeHash, receiptRevision: row.revision,
      expiresAt: expiresAt.toISOString(), decision: null }, startedAt: new Date(), completedAt: null }
  const event = { id: 'event-1', sessionId: owner.sessionId, turnId: owner.turnId, itemId: null,
    taskId: row.taskId, type: 'approval.requested', actor: 'orchestrator', correlationId: row.id,
    idempotencyKey: 'approval:approval-1:requested',
    payload: { approvalId: row.id, action: row.type, scopeHash: row.scopeHash, revision: row.revision } }
  return { row, item, event }
}
function suspendedTurn(overrides: Record<string, unknown> = {}) {
  return { id: owner.turnId, status: 'waiting_for_dependency', leaseOwnerId: null, leaseVersion: owner.turnLeaseVersion,
    leaseExpiresAt: null, ...overrides }
}
function gateInput(overrides: Record<string, unknown> = {}) {
  return { owner, action: 'gate' as const, gateTaskId, turn: suspendedTurn(), ...overrides }
}

describe('Scheduled Gate Root dependency wait fence', () => {
  it('locks the exact fully suspended Gate wait before locking Root', async () => {
    const test = transaction([[{ status: 'waiting' }], [waitRow()], [{ id: stepId, taskId: owner.rootTaskId, attempt: 1, status: 'waiting_for_tool' }], [rootRow()]])
    await expect(lockScheduledTaskGraphRootAction(test.client, gateInput())).resolves.toEqual({
      root: rootRow(), gateWait: { waitId, stepId, gateTaskId, approvalIds: [], requestAttemptCount: 0, owner, turn: suspendedTurn(),
        root: { id: owner.rootTaskId, status: 'waiting', attemptCount: owner.rootAttemptCount, waitId } },
    })
    expect(test.queryRaw).toHaveBeenCalledTimes(4)
  })

  it.each([
    ['missing wait', []],
    ['ambiguous waits', [waitRow(), { ...waitRow(), id: 'wait-2' }]],
    ['wrong target', [waitRow({ targetTaskIds: ['other-gate'] })]],
    ['nonempty matched set', [waitRow({ matchedTaskIds: [gateTaskId] })]],
    ['not suspended', [waitRow({ suspendedAt: null })]],
    ['already consumed', [waitRow({ consumedAt: new Date() })]],
    ['wrong marker', [waitRow({ result: { request: { targetTaskIds: [gateTaskId], mode: 'any', timeoutMs: 86_400_000,
      scheduledGate: { gateTaskId: 'other-gate', requestAttemptCount: 0 } } } })]],
    ['extra request field', [waitRow({ result: { request: { targetTaskIds: [gateTaskId], mode: 'any', timeoutMs: 86_400_000,
      scheduledGate: { gateTaskId, requestAttemptCount: 0 }, callerWaitId: waitId } } })]],
    ['wrong idempotency key', [waitRow({ idempotencyKey: 'forged-key' })]],
  ])('rejects %s', async (_label, waits) => {
    const test = transaction([[{ status: 'waiting' }], waits, ...(waits.length === 1
      ? [[{ id: stepId, taskId: owner.rootTaskId, attempt: 1, status: 'waiting_for_tool' }], [rootRow()]] : [])])
    await expect(lockScheduledTaskGraphRootAction(test.client, gateInput())).resolves.toBeNull()
  })

  it.each([
    ['foreign step', { id: stepId, taskId: 'other-root', attempt: 1, status: 'waiting_for_tool' }],
    ['wrong step status', { id: stepId, taskId: owner.rootTaskId, attempt: 1, status: 'running' }],
    ['wrong step attempt', { id: stepId, taskId: owner.rootTaskId, attempt: 2, status: 'waiting_for_tool' }],
  ])('rejects a %s', async (_label, step) => {
    const test = transaction([[{ status: 'waiting' }], [waitRow()], [step], [rootRow()]])
    await expect(lockScheduledTaskGraphRootAction(test.client, gateInput())).resolves.toBeNull()
  })

  it.each([
    ['partial turn handoff', suspendedTurn({ status: 'in_progress', leaseOwnerId: 'live-root-lease', leaseExpiresAt: new Date() })],
    ['stale Turn lease version', suspendedTurn({ leaseVersion: owner.turnLeaseVersion + 1 })],
    ['user wait', suspendedTurn({ status: 'waiting_for_user' })],
    ['tool wait', suspendedTurn({ status: 'waiting_for_tool' })],
  ])('rejects a %s even when a wait row exists', async (_label, turn) => {
    const test = transaction([[{ status: 'waiting' }]])
    await expect(lockScheduledTaskGraphRootAction(test.client, gateInput({ turn }))).resolves.toBeNull()
    expect(test.queryRaw).toHaveBeenCalledTimes(1)
  })

  it('accepts waiting_for_approval only with an exact current Gate approval item', async () => {
    const approval = approvalWitness()
    const test = transaction([[{ status: 'waiting' }], [waitRow()],
      [{ id: stepId, taskId: owner.rootTaskId, attempt: 1, status: 'waiting_for_tool' }], [rootRow()]],
    [approval.row], [approval.item], [approval.event])
    await expect(lockScheduledTaskGraphRootAction(test.client,
      gateInput({ turn: suspendedTurn({ status: 'waiting_for_approval' }) }))).resolves.toEqual({
      root: rootRow(), gateWait: { waitId, stepId, gateTaskId, approvalIds: ['approval-1'], requestAttemptCount: 0, owner,
        turn: suspendedTurn({ status: 'waiting_for_approval' }),
        root: { id: owner.rootTaskId, status: 'waiting', attemptCount: owner.rootAttemptCount, waitId } },
    })
    expect(test.approvalFindMany).toHaveBeenCalledOnce()
    expect(test.queryRaw).toHaveBeenCalledTimes(4)
  })

  it('rejects an approval-wait Turn with no matching active Gate receipt', async () => {
    const test = transaction([[{ status: 'waiting' }], [waitRow()],
      [{ id: stepId, taskId: owner.rootTaskId, attempt: 1, status: 'waiting_for_tool' }], [rootRow()]])
    await expect(lockScheduledTaskGraphRootAction(test.client,
      gateInput({ turn: suspendedTurn({ status: 'waiting_for_approval' }) }))).resolves.toBeNull()
    expect(test.approvalFindMany).toHaveBeenCalledOnce()
  })

  it.each([
    ['wrong Root wait ID', rootRow({ result: { ...rootResult, waitId: 'other-wait' } })],
    ['wrong Root result status', rootRow({ result: { ...rootResult, status: 'waiting_for_user' } })],
    ['stale Root attempt', rootRow({ attemptCount: owner.rootAttemptCount + 1 })],
    ['interrupted Root', rootRow({ interruptRequestedAt: new Date() })],
  ])('rejects a %s after locking the wait', async (_label, root) => {
    const test = transaction([[{ status: 'waiting' }], [waitRow()],
      [{ id: stepId, taskId: owner.rootTaskId, attempt: 1, status: 'waiting_for_tool' }], [root]])
    await expect(lockScheduledTaskGraphRootAction(test.client, gateInput())).resolves.toBeNull()
  })

  it('keeps the existing Root-running Gate path and Root Execute/Audit status rules', async () => {
    const runningRoot = rootRow({ status: 'running', result: null })
    const gate = transaction([[{ status: 'running' }], [runningRoot]])
    await expect(lockScheduledTaskGraphRootAction(gate.client,
      gateInput({ turn: { ...suspendedTurn(), status: 'in_progress', leaseOwnerId: 'root-lease', leaseExpiresAt: new Date() } })))
      .resolves.toEqual({ root: runningRoot })
    const execute = transaction([[runningRoot]])
    await expect(lockScheduledTaskGraphRootAction(execute.client,
      { owner, action: 'execute', turn: suspendedTurn() })).resolves.toEqual({ root: runningRoot })
    const audit = transaction([[rootRow()]])
    await expect(lockScheduledTaskGraphRootAction(audit.client,
      { owner, action: 'scheduled_audit_execute', turn: suspendedTurn() })).resolves.toEqual({ root: rootRow() })
  })

  it('binds the waiting proof to the exact pipeline owner, Gate target, released Turn lease, and Root wait result', () => {
    const root = rootRow(), witness = { waitId, stepId, gateTaskId, approvalIds: [], requestAttemptCount: 0, owner: pipelineOwner,
      turn: suspendedTurn(), root: { id: owner.rootTaskId, status: 'waiting' as const, attemptCount: owner.rootAttemptCount, waitId } }
    expect(scheduledGateRootWaitWitnessMatches({ owner: pipelineOwner, gateTaskId, root, witness })).toBe(true)
    expect(scheduledGateRootWaitWitnessMatches({ owner: { ...pipelineOwner, executionId: 'other-execution' }, gateTaskId, root, witness })).toBe(false)
    expect(scheduledGateRootWaitWitnessMatches({ owner: { ...pipelineOwner, turnLeaseVersion: owner.turnLeaseVersion + 1 }, gateTaskId, root, witness })).toBe(false)
    expect(scheduledGateRootWaitWitnessMatches({ owner: pipelineOwner, gateTaskId: 'other-gate', root, witness })).toBe(false)
    expect(scheduledGateRootWaitWitnessMatches({ owner: pipelineOwner, gateTaskId, root: rootRow({ status: 'running' }), witness })).toBe(false)
    const approvalWait = { ...witness, approvalIds: ['approval-1'], turn: suspendedTurn({ status: 'waiting_for_approval' }) }
    expect(scheduledGateRootWaitWitnessMatches({ owner: pipelineOwner, gateTaskId, root, witness: approvalWait })).toBe(true)
    expect(scheduledGateRootWaitWitnessMatches({ owner: pipelineOwner, gateTaskId, root,
      witness: { ...approvalWait, approvalIds: [] } })).toBe(false)
    expect(scheduledGateRootWaitWitnessMatches({ owner: pipelineOwner, gateTaskId, root,
      witness: { ...witness, approvalIds: ['approval-1'] } })).toBe(false)
  })
})

describe('Scheduled Gate wait attempt lineage binding', () => {
  const graphId = `task-graph-${createHash('sha256').update(owner.rootTaskId).digest('hex')}`
  function event(requestAttemptCount: number) {
    return { type: 'task.gate_choice_resumed', nodeKey: 'gate', gateTaskId, requestAttemptCount,
      resumedAttemptCount: requestAttemptCount + 1, expectedRevision: 17,
      idempotencyKey: `${graphId}:node:${createHash('sha256').update('gate').digest('hex').slice(0, 20)}:${requestAttemptCount}:task.gate_choice_resumed` }
  }
  it('uses the initial request only before a choice-resume event', async () => {
    const noResume = transaction([[]])
    await expect(scheduledGateWaitAttemptMatchesCurrentHistory(noResume.client, owner, gateTaskId, 0)).resolves.toBe(true)
    const resumed = transaction([[{ event: event(1) }]])
    await expect(scheduledGateWaitAttemptMatchesCurrentHistory(resumed.client, owner, gateTaskId, 0)).resolves.toBe(false)
  })
  it('binds a resumed request to the latest canonical choice event while allowing later child retries', async () => {
    await expect(scheduledGateWaitAttemptMatchesCurrentHistory(transaction([[{ event: event(1) }]]).client,
      owner, gateTaskId, 1)).resolves.toBe(true)
    await expect(scheduledGateWaitAttemptMatchesCurrentHistory(transaction([[{ event: event(2) }]]).client,
      owner, gateTaskId, 1)).resolves.toBe(false)
    await expect(scheduledGateWaitAttemptMatchesCurrentHistory(transaction([[{ event: { ...event(1),
      resumedAttemptCount: 3 } }]]).client, owner, gateTaskId, 1)).resolves.toBe(false)
  })
})
