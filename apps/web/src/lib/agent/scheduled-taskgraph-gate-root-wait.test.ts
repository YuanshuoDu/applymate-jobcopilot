import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
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
function transaction(responses: unknown[]) {
  const queryRaw = vi.fn(async () => responses.shift() ?? [])
  return { client: { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient, queryRaw }
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
      root: rootRow(), gateWait: { waitId, stepId, gateTaskId, requestAttemptCount: 0, owner, turn: suspendedTurn(),
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
    const root = rootRow(), witness = { waitId, stepId, gateTaskId, requestAttemptCount: 0, owner: pipelineOwner,
      turn: suspendedTurn(), root: { id: owner.rootTaskId, status: 'waiting' as const, attemptCount: owner.rootAttemptCount, waitId } }
    expect(scheduledGateRootWaitWitnessMatches({ owner: pipelineOwner, gateTaskId, root, witness })).toBe(true)
    expect(scheduledGateRootWaitWitnessMatches({ owner: { ...pipelineOwner, executionId: 'other-execution' }, gateTaskId, root, witness })).toBe(false)
    expect(scheduledGateRootWaitWitnessMatches({ owner: { ...pipelineOwner, turnLeaseVersion: owner.turnLeaseVersion + 1 }, gateTaskId, root, witness })).toBe(false)
    expect(scheduledGateRootWaitWitnessMatches({ owner: pipelineOwner, gateTaskId: 'other-gate', root, witness })).toBe(false)
    expect(scheduledGateRootWaitWitnessMatches({ owner: pipelineOwner, gateTaskId, root: rootRow({ status: 'running' }), witness })).toBe(false)
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
