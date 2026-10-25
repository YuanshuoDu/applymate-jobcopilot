import { createHash } from 'node:crypto'
import { AGENT_STREAM_SCHEMA_VERSION } from '@jobcopilot/agent-protocol'
import { Prisma } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import type { ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import { isScheduledTaskGraphAuditRecoveryGraphItem } from './scheduled-taskgraph-audit-recovery-graph-item'

const SCHEDULED_AUDIT_TEMPLATE_ID = 'scheduled_audit'
const SCHEDULED_AUDIT_NODE_GOAL = 'Return the exact report from the authenticated scheduled Audit continuation after Gate completion.'
const SCHEDULED_AUDIT_NODE_CRITERIA = ['Continue the exact scheduled execution only after its canonical Gate proof is verified.',
  'Return only the fixed seven-field report without adding actions or interpreting historical counts.',
  'Never submit applications or invoke model or tool runtimes.']
const VERIFICATION_SCHEMA = 'agent-harness.v2.task-graph-verification.v1'
const scoutVerification = { schemaVersion: VERIFICATION_SCHEMA, role: 'scout', criteria: [
  { id: 'candidate-count', check: { kind: 'candidate_count_gte', minimum: 1 } },
  { id: 'candidate-evidence', check: { kind: 'all_candidates_have_evidence', minimumItems: 1 } },
] }
const analystVerification = (scoutKey: string) => ({ schemaVersion: VERIFICATION_SCHEMA, role: 'analyst', criteria: [
  { id: 'scout-membership', check: { kind: 'findings_from_scout_dependency', dependencyNodeKey: scoutKey } },
  { id: 'finding-count', check: { kind: 'finding_count_gte', minimum: 1 } },
] })
const owner: ScheduledTaskGraphPipelineOwner = { userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1',
  rootAttemptCount: 2, turnLeaseOwnerId: 'worker-1', turnLeaseVersion: 3, executionId: 'execution-1', executionAttemptCount: 0 }
const rootId = owner.rootTaskId
const stepId = 'recovery-step-1'
const itemId = `task-graph-${createHash('sha256').update(rootId).digest('hex')}`
const revision = 6
type RecoveryGraphNode = { key: string; templateId: string; goal: string; successCriteria: string[]; dependsOn: string[];
  depth: number; taskId: string; verificationDisposition: string; verification?: unknown }
type RecoveryGraphSnapshot = { schemaVersion: string; nodes: RecoveryGraphNode[] }
const snapshot: RecoveryGraphSnapshot = { schemaVersion: 'agent-harness.v2.task-graph', nodes: [
  { key: 'scout', templateId: 'scout', goal: 'Find evidence', successCriteria: ['Found evidence'], dependsOn: [], depth: 1,
    taskId: 'scout-child-1', verificationDisposition: 'typed', verification: scoutVerification },
  { key: 'analyst', templateId: 'analyst', goal: 'Review evidence', successCriteria: ['Reviewed evidence'], dependsOn: ['scout'], depth: 2,
    taskId: 'analyst-child-1', verificationDisposition: 'typed', verification: analystVerification('scout') },
  { key: 'prepare', templateId: 'prepare', goal: 'Prepare the application', successCriteria: ['Preparation is complete'], dependsOn: ['analyst'], depth: 3,
    taskId: 'prepare-child-1', verificationDisposition: 'specialized' },
  { key: 'gate', templateId: 'gate', goal: 'Review the application', successCriteria: ['Review is complete'], dependsOn: ['prepare'], depth: 4,
    taskId: 'gate-child-1', verificationDisposition: 'specialized' },
  { key: SCHEDULED_AUDIT_TEMPLATE_ID, templateId: SCHEDULED_AUDIT_TEMPLATE_ID, goal: SCHEDULED_AUDIT_NODE_GOAL,
    successCriteria: SCHEDULED_AUDIT_NODE_CRITERIA, dependsOn: ['gate'], depth: 5,
    taskId: 'audit-child-1', verificationDisposition: 'specialized' },
] }
function snapshotWithAliases(scoutKey = 'scout', analystKey = 'analyst') {
  const nodes = [...snapshot.nodes]
  nodes[0] = { ...nodes[0]!, key: scoutKey }
  nodes[1] = { ...nodes[1]!, key: analystKey, dependsOn: [scoutKey], verification: analystVerification(scoutKey) }
  nodes[2] = { ...nodes[2]!, dependsOn: [analystKey] }
  return { ...snapshot, nodes }
}

type GraphRow = Readonly<Record<string, unknown>>
function graphItem(overrides: Record<string, unknown> = {}): GraphRow {
  return { id: itemId, sessionId: owner.sessionId, turnId: owner.turnId, stepId, taskId: rootId, type: 'task_graph',
    status: 'streaming', phase: null, revision: revision + 1, content: snapshot, ...overrides }
}
function proposalEvent(options: Readonly<{ proposalStepId?: string; eventId?: string; proposalRevision?: number;
  itemContent?: unknown; eventOverrides?: Record<string, unknown>; payloadOverrides?: Record<string, unknown> }> = {}): GraphRow {
  const proposalRevision = options.proposalRevision ?? revision
  const proposalStepId = options.proposalStepId ?? stepId
  const content = options.itemContent ?? snapshot
  const dto = { schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: itemId, sessionId: owner.sessionId, turnId: owner.turnId,
    stepId: proposalStepId, taskId: rootId, type: 'task_graph', status: 'streaming', phase: null, revision: proposalRevision,
    content, startedAt: '2026-10-25T12:10:00.000Z', completedAt: null, createdAt: '2026-10-25T12:10:00.000Z',
    updatedAt: '2026-10-25T12:10:00.000Z' }
  const payload = { kind: 'proposal', fingerprint: 'f'.repeat(64), revision: proposalRevision,
    receipt: { status: 'accepted', revision: proposalRevision,
      nodes: [{ key: SCHEDULED_AUDIT_TEMPLATE_ID, taskId: 'audit-child-1', status: 'queued' }], readyTaskIds: ['audit-child-1'] },
    item: dto, content, ...options.payloadOverrides }
  return { id: options.eventId ?? `${proposalStepId}-proposal`, sessionId: owner.sessionId, turnId: owner.turnId,
    taskId: rootId, itemId, type: 'item.delta', actor: 'orchestrator', correlationId: owner.turnId,
    causationId: proposalStepId, idempotencyKey: `${itemId}:proposal:${proposalRevision - 1}`, payload,
    ...options.eventOverrides }
}
function reader(events: readonly GraphRow[]) {
  return { agentEvent: { findMany: vi.fn(async () => events) } } as unknown as Prisma.TransactionClient
}
function validate(item: GraphRow, events: readonly GraphRow[], currentStepId = stepId) {
  const db = reader(events)
  return { db, result: isScheduledTaskGraphAuditRecoveryGraphItem({ reader: db, owner, stepId: currentStepId, item }) }
}

describe('scheduled TaskGraph Audit recovery graph item', () => {
  it('accepts the exact server proposal receipt and a later row revision', async () => {
    const item = graphItem(), event = proposalEvent()
    const { db, result } = validate(item, [event])
    await expect(result).resolves.toBe(true)
    expect(db.agentEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ sessionId: owner.sessionId, turnId: owner.turnId, taskId: rootId,
        itemId, type: 'item.delta', actor: 'orchestrator', correlationId: owner.turnId, causationId: stepId }), take: 2,
    }))
  })

  it('accepts the scheduled Scout and Analyst keys while preserving semantic templates', async () => {
    const aliased = snapshotWithAliases('scheduled-scout', 'scheduled-analyst')
    await expect(validate(graphItem({ content: aliased }), [proposalEvent({ itemContent: aliased })]).result).resolves.toBe(true)
  })

  it('requires the moved singleton to have its own current-step proposal receipt', async () => {
    const r2 = 'recovery-step-2', moved = graphItem({ stepId: r2, revision: revision + 2 })
    await expect(validate(moved, [proposalEvent()], r2).result).resolves.toBe(false)
    await expect(validate(moved, [proposalEvent({ proposalStepId: r2, proposalRevision: revision + 1 })], r2).result).resolves.toBe(true)
  })

  it.each([
    ['missing event', []],
    ['duplicate event', [proposalEvent(), proposalEvent({ eventId: 'duplicate-proposal' })]],
    ['foreign owner', [proposalEvent({ eventOverrides: { sessionId: 'foreign-session' } })]],
    ['wrong event key', [proposalEvent({ eventOverrides: { idempotencyKey: 'wrong-key' } })]],
    ['wrong causal step', [proposalEvent({ proposalStepId: 'other-step' })]],
    ['changed event content', [proposalEvent({ itemContent: { ...snapshot, changed: true } })]],
    ['unexpected payload key', [proposalEvent({ payloadOverrides: { extra: true } })]],
  ] as const)('rejects %s', async (_label, events) => {
    await expect(validate(graphItem(), events).result).resolves.toBe(false)
  })

  it.each(['unexpected semantic template order', 'broken predecessor edge', 'wrong semantic template', 'duplicate aliases',
    'fixed key collision', 'invalid alias', 'root task reused as a child'] as const)('rejects %s', async change => {
    const nodes = [...snapshot.nodes]
    if (change === 'unexpected semantic template order') [nodes[0], nodes[1]] = [nodes[1]!, nodes[0]!]
    else if (change === 'broken predecessor edge') nodes[2] = { ...nodes[2]!, dependsOn: ['scout'] }
    else if (change === 'wrong semantic template') nodes[0] = { ...nodes[0]!, templateId: 'analyst' }
    else if (change === 'duplicate aliases') { nodes[0] = { ...nodes[0]!, key: 'same' }; nodes[1] = { ...nodes[1]!, key: 'same', dependsOn: ['same'] } }
    else if (change === 'fixed key collision') nodes[0] = { ...nodes[0]!, key: 'prepare' }
    else if (change === 'invalid alias') nodes[0] = { ...nodes[0]!, key: ' ' }
    else nodes[0] = { ...nodes[0]!, taskId: rootId }
    const changed = { ...snapshot, nodes }
    await expect(validate(graphItem({ content: changed }), [proposalEvent({ itemContent: changed })]).result).resolves.toBe(false)
  })

  it('rejects a foreign current item and content changed after the immutable proposal', async () => {
    await expect(validate(graphItem({ turnId: 'foreign-turn' }), [proposalEvent()]).result).resolves.toBe(false)
    await expect(validate(graphItem({ content: { ...snapshot, mutated: true } }), [proposalEvent()]).result).resolves.toBe(false)
  })
})
