import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import { scheduledTaskGraphGateHistoryIsCurrent } from './scheduled-taskgraph-gate-history'

const owner = { userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1',
  rootAttemptCount: 1, turnLeaseOwnerId: 'root-lease', turnLeaseVersion: 1, executionId: 'execution-1', executionAttemptCount: 1 }
const graphId = `task-graph-${createHash('sha256').update(owner.rootTaskId).digest('hex')}`
const prefix = { schemaVersion: 'agent-harness.v2.task-graph', nodes: [
  { key: 'scout', taskId: 'scout-1', status: 'completed' },
  { key: 'analyze', taskId: 'analyze-1', status: 'completed' },
  { key: 'prepare', taskId: 'prepare-1', status: 'completed' },
] }
const proposalSnapshot = { ...prefix, nodes: [...prefix.nodes, { key: 'gate', templateId: 'gate', taskId: 'gate-1', depth: 4,
  dependsOn: ['prepare'], verificationDisposition: 'specialized', status: 'queued' }] }
const gateResult = { finalItemId: null, finalText: '', status: 'completed', stepCount: 0, toolCallCount: 0,
  taskGraphVerificationReport: null,
  structuredResult: { status: 'completed', nextStage: 'execute', approvedJobIds: [], pendingJobIds: ['job-1'], skippedJobIds: [],
    counts: { approved: 0, pending: 1, skipped: 0 } } }

function lifecycle(type: string, attempt: number, expectedRevision: number, sequence: bigint) {
  const idempotencyKey = `${graphId}:node:${createHash('sha256').update('gate').digest('hex').slice(0, 20)}:${attempt}:${type}`
  const status = type === 'task.started' ? 'running' : type === 'task.completed' ? 'completed' : 'queued'
  const content = { ...proposalSnapshot, nodes: [...proposalSnapshot.nodes.slice(0, 3), { ...proposalSnapshot.nodes[3], status }] }
  return { id: `event-${sequence}`, sessionId: owner.sessionId, turnId: owner.turnId, itemId: graphId, taskId: owner.rootTaskId,
    type: 'item.delta', actor: 'system', idempotencyKey, sequence,
    payload: { kind: 'lifecycle', revision: expectedRevision + 1,
      event: { type, idempotencyKey, expectedRevision, nodeKey: 'gate' },
      item: { id: graphId, sessionId: owner.sessionId, turnId: owner.turnId, taskId: owner.rootTaskId,
        type: 'task_graph', revision: expectedRevision + 1, content } } }
}

function fixture(maxAttempts = 3) {
  const prepareKey = `${graphId}:node:${createHash('sha256').update('prepare').digest('hex').slice(0, 20)}:1:task.completed`
  const prepare = { id: 'prepare-event', sessionId: owner.sessionId, turnId: owner.turnId, itemId: graphId, taskId: owner.rootTaskId,
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
  const completedSnapshot = { ...proposalSnapshot, nodes: [...proposalSnapshot.nodes.slice(0, 3), { ...proposalSnapshot.nodes[3], status: 'completed' }] }
  const input = { reader, owner, prepareGraphRevision: 10, prepareAttemptCount: 1, graphRevision: 15, graphContent: completedSnapshot,
    gateTask: { id: 'gate-1', status: 'completed', attemptCount: 2, maxAttempts, result: gateResult },
    gate: { taskId: 'gate-1', attemptCount: 2, phase: 'completed' as const, completionProof: { schemaVersion:
      'agent-harness.v2.scheduled-taskgraph-gate-completion.v1', graphRevision: 15, prepareProof: {}, gate: { taskId: 'gate-1',
        attemptCount: 2, resultDigest: digest, completedEventRevision: 15 } } }, expectedJobIds: ['job-1'] }
  return { input, findMany }
}

describe('scheduled TaskGraph Gate lifecycle history', () => {
  it('accepts a persisted retrying-to-started chain when the later attempt completes', async () => {
    const { input, findMany } = fixture()
    const result = await scheduledTaskGraphGateHistoryIsCurrent(input)
    expect(findMany).toHaveBeenCalledTimes(2)
    expect(result).toBe(true)
  })

  it('rejects a generic retry beyond the persisted maxAttempts ceiling', async () => {
    const { input } = fixture(1)
    await expect(scheduledTaskGraphGateHistoryIsCurrent(input)).resolves.toBe(false)
  })
})

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
