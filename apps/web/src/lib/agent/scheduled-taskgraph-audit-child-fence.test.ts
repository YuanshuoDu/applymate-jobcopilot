import { describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { lockScheduledTaskGraphAuditChildFence, type ScheduledTaskGraphAuditActor,
  type ScheduledTaskGraphAuditChildFenceInput } from './scheduled-taskgraph-audit-child-fence'
import type { ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'

const owner: ScheduledTaskGraphPipelineOwner = { userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1',
  rootAttemptCount: 3, turnLeaseOwnerId: 'historical-root-owner', turnLeaseVersion: 8, executionId: 'execution-1', executionAttemptCount: 2 }
const actor: ScheduledTaskGraphAuditActor = { taskId: 'audit-1', attemptCount: 2, leaseOwner: 'audit-worker-2' }
const auditSchema = { schemaVersion: 'agent-harness.v2.subagent.result', role: 'auditor', taskType: 'scheduled_taskgraph_audit' }
type Row = Record<string, unknown>

function rows(overrides: { session?: Row; pauses?: Row[]; turn?: Row; root?: Row; child?: Row; dispatches?: Row[] } = {}): unknown[][] {
  return [
    [overrides.session ?? { id: owner.sessionId, status: 'running' }],
    overrides.pauses ?? [],
    [overrides.turn ?? { id: owner.turnId, userId: owner.userId, sessionId: owner.sessionId, rootTaskId: owner.rootTaskId,
      source: 'automation', executionMode: 'canonical_task_graph', input: { automationRunMode: 'scheduled' }, status: 'in_progress',
      leaseOwnerId: 'expired-root-lease', leaseExpiresAt: new Date(1), leaseStartedAt: new Date(0),
      terminalEventSequence: null, terminalEventAt: null }],
    [overrides.root ?? { id: owner.rootTaskId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
      parentTaskId: null, status: 'running', attemptCount: owner.rootAttemptCount, role: 'orchestrator', taskType: 'root',
      failureReason: null, interruptRequestedAt: null, closedAt: null }],
    [overrides.child ?? { id: actor.taskId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
      parentTaskId: owner.rootTaskId, depth: 1, role: 'auditor', taskType: 'scheduled_taskgraph_audit', status: 'running',
      attemptCount: actor.attemptCount, maxAttempts: 3, leaseOwner: actor.leaseOwner, leaseExpiresAt: new Date(1),
      interruptRequestedAt: null, closedAt: null, failureReason: null, context: {}, expectedOutputSchema: auditSchema,
      allowedActions: [], hasLiveLease: true }],
    overrides.dispatches ?? [{ id: 'dispatch-1' }],
  ]
}

function harness(resultRows: unknown[][]) {
  const pending = [...resultRows], query = vi.fn(async (_statement: unknown) => pending.shift() ?? [])
  return { tx: { $queryRaw: query } as unknown as Prisma.TransactionClient, query }
}
function input(overrides: Partial<ScheduledTaskGraphAuditChildFenceInput> = {}): ScheduledTaskGraphAuditChildFenceInput {
  return { owner, auditActor: actor, ...overrides }
}
function sqlAt(query: ReturnType<typeof harness>['query'], index: number): string {
  return String((query.mock.calls[index]?.[0] as { sql?: unknown } | undefined)?.sql ?? '')
}

describe('scheduled Audit child owner fence', () => {
  it.each([
    ['child before Root parks', { status: 'in_progress', leaseOwnerId: 'expired-root-lease', leaseExpiresAt: new Date(1), leaseStartedAt: new Date(0) }, 'running'],
    ['child after Root parks', { status: 'waiting_for_dependency', leaseOwnerId: null, leaseExpiresAt: null, leaseStartedAt: null }, 'waiting'],
    ['child while Root is waking', { status: 'queued', leaseOwnerId: null, leaseExpiresAt: null, leaseStartedAt: null }, 'running'],
  ] as const)('accepts the exact live child lease when %s without borrowing a Root lease', async (_name, turnState, rootStatus) => {
    const values = rows({ turn: { ...rows()[2]![0] as Row, ...turnState }, root: { ...rows()[3]![0] as Row, status: rootStatus } })
    const { tx } = harness(values)
    await expect(lockScheduledTaskGraphAuditChildFence(tx, input())).resolves.toMatchObject({
      taskId: actor.taskId, attemptCount: actor.attemptCount, leaseOwner: actor.leaseOwner,
      rootStatus, turnStatus: turnState.status,
    })
  })

  it.each([
    ['expired child lease', { hasLiveLease: false }],
    ['wrong child attempt', { attemptCount: actor.attemptCount - 1 }],
    ['wrong child owner', { leaseOwner: 'other-worker' }],
    ['foreign child root', { rootTaskId: 'foreign-root' }],
    ['interrupted child', { interruptRequestedAt: new Date() }],
    ['closed child', { closedAt: new Date() }],
    ['wrong private context', { context: { extra: true } }],
    ['wrong allowed actions', { allowedActions: ['gmail.send'] }],
  ] as const)('rejects an %s', async (_name, child) => {
    const { tx } = harness(rows({ child: { ...rows()[4]![0] as Row, ...child } }))
    await expect(lockScheduledTaskGraphAuditChildFence(tx, input())).resolves.toBeNull()
  })

  it.each([
    ['terminal Session', rows({ session: { id: owner.sessionId, status: 'archived' } })],
    ['pending Session pause', rows({ pauses: [{ id: 'pause-1' }] })],
    ['terminal Turn', rows({ turn: { ...rows()[2]![0] as Row, status: 'completed' } })],
    ['foreign Turn source', rows({ turn: { ...rows()[2]![0] as Row, source: 'manual' } })],
    ['terminal Root', rows({ root: { ...rows()[3]![0] as Row, status: 'completed' } })],
    ['newer Root attempt', rows({ root: { ...rows()[3]![0] as Row, attemptCount: owner.rootAttemptCount + 1 } })],
    ['interrupted Root', rows({ root: { ...rows()[3]![0] as Row, interruptRequestedAt: new Date() } })],
    ['missing dispatch record', rows({ dispatches: [] })],
  ] as const)('rejects a %s', async (_name, responseRows) => {
    const { tx } = harness(responseRows)
    await expect(lockScheduledTaskGraphAuditChildFence(tx, input())).resolves.toBeNull()
  })

  it('locks Session, Turn, Root, then the Audit task and checks lease expiry with database time', async () => {
    const { tx, query } = harness(rows())
    await expect(lockScheduledTaskGraphAuditChildFence(tx, input())).resolves.not.toBeNull()
    expect(query).toHaveBeenCalledTimes(6)
    expect(sqlAt(query, 0)).toContain('FROM "agent_sessions"')
    expect(sqlAt(query, 0)).toContain('FOR UPDATE')
    expect(sqlAt(query, 2)).toContain('FROM "agent_turns"')
    expect(sqlAt(query, 2)).toContain('FOR UPDATE')
    expect(sqlAt(query, 3)).toContain('FROM "sub_agent_tasks"')
    expect(sqlAt(query, 3)).toContain('FOR UPDATE')
    expect(sqlAt(query, 4)).toContain('"leaseExpiresAt" > clock_timestamp()')
    expect(sqlAt(query, 4)).toContain('FOR UPDATE')
    expect(sqlAt(query, 5)).toContain('"idempotencyKey" = ?')
  })

  it('accepts execution attempt zero but rejects a negative execution attempt', async () => {
    const zeroAttemptOwner = { ...owner, executionAttemptCount: 0 }
    await expect(lockScheduledTaskGraphAuditChildFence(harness(rows()).tx, input({ owner: zeroAttemptOwner }))).resolves.not.toBeNull()
    const negativeAttemptOwner = { ...owner, executionAttemptCount: -1 }
    const { tx, query } = harness(rows())
    await expect(lockScheduledTaskGraphAuditChildFence(tx, input({ owner: negativeAttemptOwner }))).resolves.toBeNull()
    expect(query).not.toHaveBeenCalled()
  })
})
