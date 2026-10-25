import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import { scheduledTaskGraphGateBindingIsCurrent, scheduledTaskGraphGateHistoryIsCurrent } from './scheduled-taskgraph-gate-history'

const owner = { userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1',
  rootAttemptCount: 1, turnLeaseOwnerId: 'root-lease', turnLeaseVersion: 1, executionId: 'execution-1', executionAttemptCount: 1 }
const graphId = `task-graph-${createHash('sha256').update(owner.rootTaskId).digest('hex')}`
const prefix = { schemaVersion: 'agent-harness.v2.task-graph', nodes: [
  { key: 'scout', taskId: 'scout-1' },
  { key: 'analyze', taskId: 'analyze-1' },
  { key: 'prepare', taskId: 'prepare-1' },
] }
const proposalSnapshot = { ...prefix, nodes: [...prefix.nodes, { key: 'gate', templateId: 'gate', taskId: 'gate-1', depth: 4,
  dependsOn: ['prepare'], verificationDisposition: 'specialized' }] }
const gateResult = { finalItemId: null, finalText: '', status: 'completed', stepCount: 0, toolCallCount: 0,
  taskGraphVerificationReport: null,
  structuredResult: { status: 'completed', nextStage: 'execute', approvedJobIds: [], pendingJobIds: ['job-1'], skippedJobIds: [],
    counts: { approved: 0, pending: 1, skipped: 0 } } }

function lifecycle(type: string, attempt: number, expectedRevision: number, sequence: bigint) {
  const idempotencyKey = `${graphId}:node:${createHash('sha256').update('gate').digest('hex').slice(0, 20)}:${attempt}:${type}`
  return { id: `event-${sequence}`, sessionId: owner.sessionId, turnId: owner.turnId, itemId: graphId, taskId: 'gate-1',
    type: 'item.delta', actor: 'system', idempotencyKey, sequence,
    payload: { kind: 'lifecycle', revision: expectedRevision + 1,
      event: { type, idempotencyKey, expectedRevision, nodeKey: 'gate' },
      item: { id: graphId, sessionId: owner.sessionId, turnId: owner.turnId, taskId: owner.rootTaskId,
        type: 'task_graph', revision: expectedRevision + 1, content: proposalSnapshot } } }
}

function fixture(maxAttempts = 3) {
  const prepareKey = `${graphId}:node:${createHash('sha256').update('prepare').digest('hex').slice(0, 20)}:1:task.completed`
  const prepare = { id: 'prepare-event', sessionId: owner.sessionId, turnId: owner.turnId, itemId: graphId, taskId: 'prepare-1',
    type: 'item.delta', actor: 'system', idempotencyKey: prepareKey, sequence: BigInt(100),
    payload: { kind: 'lifecycle', revision: 10,
      event: { type: 'task.completed', idempotencyKey: prepareKey, expectedRevision: 9, nodeKey: 'prepare' },
      item: { id: graphId, sessionId: owner.sessionId, turnId: owner.turnId, taskId: owner.rootTaskId,
        type: 'task_graph', revision: 10, content: prefix } } }
  const proposal = { id: 'proposal-event', sessionId: owner.sessionId, turnId: owner.turnId, itemId: graphId, taskId: owner.rootTaskId,
    type: 'item.delta', actor: 'orchestrator', idempotencyKey: `${graphId}:proposal:10`, sequence: BigInt(101),
    payload: { kind: 'proposal', revision: 11, fingerprint: 'a'.repeat(64), content: proposalSnapshot,
      receipt: { status: 'accepted', revision: 11, nodes: [{ key: 'gate', taskId: 'gate-1', status: 'queued' }], readyTaskIds: ['gate-1'] } } }
  const rows = [proposal,
    lifecycle('task.started', 1, 11, BigInt(102)),
    lifecycle('task.retrying', 1, 12, BigInt(103)),
    lifecycle('task.started', 2, 13, BigInt(104)),
    lifecycle('task.completed', 2, 14, BigInt(105))]
  const findMany = vi.fn(async (args: { where: { idempotencyKey?: string } }) => args.where.idempotencyKey ? [prepare] : rows)
  const reader = { agentEvent: { findMany } } as unknown as Prisma.TransactionClient
  const digest = `sha256:${createHash('sha256').update(canonicalJson(gateResult), 'utf8').digest('hex')}`
  const input = { reader, owner, prepareTaskId: 'prepare-1', prepareGraphRevision: 10, prepareAttemptCount: 1, graphRevision: 15, graphContent: proposalSnapshot,
    gateTask: { id: 'gate-1', status: 'completed', attemptCount: 2, maxAttempts, result: gateResult },
    gate: { taskId: 'gate-1', attemptCount: 2, phase: 'completed' as const, completionProof: { schemaVersion:
      'agent-harness.v2.scheduled-taskgraph-gate-completion.v1', graphRevision: 15, prepareProof: {}, gate: { taskId: 'gate-1',
        attemptCount: 2, resultDigest: digest, completedEventRevision: 15 } } }, expectedJobIds: ['job-1'] }
  return { input, findMany, prepare, rows }
}

describe('scheduled TaskGraph Gate lifecycle history', () => {
  it('binds the Prepare wait to the validated handoff key, not the stable receipt key', async () => {
    const { input, queryRaw, prepareHandoffKey, stableReceiptKey } = bindingFixture()
    expect(prepareHandoffKey).not.toBe(stableReceiptKey)
    await expect(scheduledTaskGraphGateBindingIsCurrent(input)).resolves.toBe(true)
    expect(queryRaw).toHaveBeenCalledTimes(2)
  })

  it('rejects a Prepare wait hashed from the stable receipt key', async () => {
    const { input } = bindingFixture(stableReceiptKeyForBinding)
    await expect(scheduledTaskGraphGateBindingIsCurrent(input)).resolves.toBe(false)
  })

  it('accepts a persisted retrying-to-started chain when the later attempt completes', async () => {
    const { input, findMany } = fixture()
    const result = await scheduledTaskGraphGateHistoryIsCurrent(input)
    expect(findMany).toHaveBeenCalledTimes(2)
    expect(findMany.mock.calls[0]?.[0].where).toMatchObject({
      sessionId: owner.sessionId, turnId: owner.turnId, itemId: graphId, idempotencyKey: expect.any(String),
    })
    expect(findMany.mock.calls[0]?.[0].where).not.toHaveProperty('taskId')
    expect(findMany.mock.calls[1]?.[0].where).not.toHaveProperty('taskId')
    expect(result).toBe(true)
  })

  it('accepts a statusless snapshot while the Gate child is running', async () => {
    const { input, rows } = fixture()
    const proposal = rows[0]!
    rows.splice(0, rows.length, proposal, lifecycle('task.started', 1, 11, BigInt(102)))
    const runningInput = { ...input, graphRevision: 12, graphContent: proposalSnapshot,
      gateTask: { ...input.gateTask, status: 'running', attemptCount: 1 },
      gate: { taskId: 'gate-1', attemptCount: 1, phase: 'running' as const } }
    await expect(scheduledTaskGraphGateHistoryIsCurrent(runningInput)).resolves.toBe(true)
  })

  it('rejects extra content on a Gate lifecycle snapshot', async () => {
    const { input, rows } = fixture()
    const event = rows[1] as ReturnType<typeof lifecycle>
    const statusNode = { ...proposalSnapshot.nodes[3]!, status: 'running' }
    event.payload.item.content = { ...proposalSnapshot, nodes: [...proposalSnapshot.nodes.slice(0, 3), statusNode] }
    await expect(scheduledTaskGraphGateHistoryIsCurrent(input)).resolves.toBe(false)
  })

  it('rejects a Prepare completion event attached to the root task', async () => {
    const { input, prepare } = fixture()
    prepare.taskId = owner.rootTaskId
    await expect(scheduledTaskGraphGateHistoryIsCurrent(input)).resolves.toBe(false)
  })

  it('rejects a Prepare completion event attached to another child task', async () => {
    const { input, prepare } = fixture()
    prepare.taskId = 'other-prepare'
    await expect(scheduledTaskGraphGateHistoryIsCurrent(input)).resolves.toBe(false)
  })

  it('rejects a Gate lifecycle event attached to the root task', async () => {
    const { input, rows } = fixture()
    rows[1]!.taskId = owner.rootTaskId
    await expect(scheduledTaskGraphGateHistoryIsCurrent(input)).resolves.toBe(false)
  })

  it('rejects a Gate lifecycle event attached to a different child task', async () => {
    const { input, rows } = fixture()
    rows[1]!.taskId = 'other-gate'
    await expect(scheduledTaskGraphGateHistoryIsCurrent(input)).resolves.toBe(false)
  })

  it('rejects a generic retry beyond the persisted maxAttempts ceiling', async () => {
    const { input } = fixture(1)
    await expect(scheduledTaskGraphGateHistoryIsCurrent(input)).resolves.toBe(false)
  })
})

const prepareHandoffKey = `scheduled-taskgraph:sha256:${'a'.repeat(64)}`
const stableReceiptKeyForBinding = `scheduled-taskgraph:sha256:${'b'.repeat(64)}`

function bindingFixture(waitKeyContinuation = prepareHandoffKey) {
  const bindingOwner = { userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1',
    rootAttemptCount: 1, executionId: 'execution-1', executionAttemptCount: 1 }
  const marker = { key: prepareHandoffKey, snapshotDigest: `sha256:${'c'.repeat(64)}`,
    evidenceDigest: 'd'.repeat(64), graphRevision: 9 }
  const checkpointDigest = `sha256:${'e'.repeat(64)}`
  const proof = { receipt: { continuationKey: stableReceiptKeyForBinding, snapshotDigest: marker.snapshotDigest,
    evidenceDigest: marker.evidenceDigest, checkpointDigest, analyzeGraphRevision: marker.graphRevision, prepareScheduleRevision: 10 },
    completion: { wait: { waitId: 'prepare-wait-1' } }, graphRevision: 11, result: { taskId: 'prepare-task-1' } }
  const gate = { taskId: 'gate-task-1', attemptCount: 1, phase: 'running' as const }
  const eventKey = `scheduled-gate-binding:${createHash('sha256').update(JSON.stringify([stableReceiptKeyForBinding, gate.taskId]), 'utf8').digest('hex')}`
  const event = { itemId: null, taskId: null, actor: 'system', idempotencyKey: eventKey, hasOutbox: false,
    payload: { schemaVersion: 'agent-harness.v2.scheduled-taskgraph-gate-binding.v1', owner: bindingOwner,
      continuationKey: stableReceiptKeyForBinding, snapshotDigest: marker.snapshotDigest, evidenceDigest: marker.evidenceDigest,
      checkpointDigest, analyzeGraphRevision: marker.graphRevision, prepareScheduleRevision: 10,
      prepareWaitId: 'prepare-wait-1', gateTaskId: gate.taskId, gateAppendRevision: 12 } }
  const stepId = 'root-step-1'
  const waitKey = `scheduled-prepare-dependency:${createHash('sha256').update(`${waitKeyContinuation}\0${stepId}`, 'utf8').digest('hex')}`
  const wait = { id: 'prepare-wait-1', userId: bindingOwner.userId, sessionId: bindingOwner.sessionId,
    turnId: bindingOwner.turnId, parentTaskId: bindingOwner.rootTaskId, stepId, idempotencyKey: waitKey,
    targetTaskIds: ['prepare-task-1'], mode: 'all', status: 'ready', matchedTaskIds: ['prepare-task-1'],
    result: { request: { targetTaskIds: ['prepare-task-1'], mode: 'all', timeoutMs: 86_400_000 } },
    stepTaskId: bindingOwner.rootTaskId, stepAttempt: 1 }
  const queryRaw = vi.fn().mockResolvedValueOnce([event]).mockResolvedValueOnce([wait])
  const input = { reader: { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient,
    owner: { ...bindingOwner, turnLeaseOwnerId: 'root-lease', turnLeaseVersion: 1 }, marker, checkpointDigest,
    proof: proof as unknown as Parameters<typeof scheduledTaskGraphGateBindingIsCurrent>[0]['proof'], gate }
  return { input, queryRaw, prepareHandoffKey, stableReceiptKey: stableReceiptKeyForBinding }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('invalid_test_json')
  return encoded
}
