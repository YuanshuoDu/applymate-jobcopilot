import { Prisma } from '@prisma/client'
import type { ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'

const AUDIT_TYPE = 'scheduled_taskgraph_audit'
const AUDIT_SCHEMA = { schemaVersion: 'agent-harness.v2.subagent.result', role: 'auditor', taskType: AUDIT_TYPE }
const TURN_STATUSES = new Set(['queued', 'in_progress', 'waiting_for_dependency'])
const ROOT_STATUSES = new Set(['running', 'waiting'])

export type ScheduledTaskGraphAuditActor = Readonly<{ taskId: string; attemptCount: number; leaseOwner: string }>
export type ScheduledTaskGraphAuditChildFenceInput = Readonly<{
  owner: ScheduledTaskGraphPipelineOwner
  auditActor: ScheduledTaskGraphAuditActor
}>
export type ScheduledTaskGraphAuditChildFence = Readonly<{
  taskId: string; attemptCount: number; leaseOwner: string; rootStatus: string; turnStatus: string
}>

/** Locks the complete parent/child scope before authorizing a dispatched Audit lease. */
export async function lockScheduledTaskGraphAuditChildFence(tx: Prisma.TransactionClient,
  input: ScheduledTaskGraphAuditChildFenceInput): Promise<ScheduledTaskGraphAuditChildFence | null> {
  const { owner, auditActor } = input
  if (!validOwner(owner) || !validActor(auditActor)) return null
  try {
    const sessions = await tx.$queryRaw<Array<{ id: string; status: string }>>(Prisma.sql`
      SELECT "id", "status" FROM "agent_sessions"
      WHERE "id" = ${owner.sessionId} AND "userId" = ${owner.userId} FOR UPDATE
    `)
    if (sessions.length !== 1 || sessions[0]!.status !== 'running') return null
    const pauses = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT pause."id" FROM "agent_events" AS pause
      WHERE pause."sessionId" = ${owner.sessionId} AND pause."turnId" = ${owner.turnId}
        AND pause."type" = 'session.pause_requested'
        AND NOT EXISTS (SELECT 1 FROM "agent_events" AS resumed
          WHERE resumed."sessionId" = pause."sessionId" AND resumed."turnId" = pause."turnId"
            AND resumed."type" = 'session.resume_requested' AND resumed."sequence" > pause."sequence")
      ORDER BY pause."sequence" DESC LIMIT 1
    `)
    if (pauses.length) return null
    const turns = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT "id", "userId", "sessionId", "rootTaskId", "source", "executionMode", "input", "status",
        "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "terminalEventSequence", "terminalEventAt"
      FROM "agent_turns" WHERE "id" = ${owner.turnId} AND "userId" = ${owner.userId}
        AND "sessionId" = ${owner.sessionId} AND "rootTaskId" = ${owner.rootTaskId} FOR UPDATE
    `)
    const turn = turns[0], turnInput = record(turn?.input)
    if (turns.length !== 1 || !turn || turn.id !== owner.turnId || turn.userId !== owner.userId
      || turn.sessionId !== owner.sessionId || turn.rootTaskId !== owner.rootTaskId || !TURN_STATUSES.has(String(turn.status))
      || turn.source !== 'automation' || turn.executionMode !== 'canonical_task_graph'
      || turnInput?.automationRunMode !== 'scheduled' || turn.terminalEventSequence != null || turn.terminalEventAt != null
      || turn.status !== 'in_progress' && (turn.leaseOwnerId != null || turn.leaseExpiresAt != null || turn.leaseStartedAt != null)) return null
    const roots = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT "id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "status", "attemptCount", "role", "taskType",
        "failureReason", "interruptRequestedAt", "closedAt"
      FROM "sub_agent_tasks" WHERE "id" = ${owner.rootTaskId} AND "sessionId" = ${owner.sessionId}
        AND "turnId" = ${owner.turnId} AND "rootTaskId" = ${owner.rootTaskId} AND "parentTaskId" IS NULL
        AND "role" = 'orchestrator' AND "taskType" = 'root' AND "attemptCount" = ${owner.rootAttemptCount}
        AND "status" IN ('running', 'waiting') AND "failureReason" IS NULL
        AND "interruptRequestedAt" IS NULL AND "closedAt" IS NULL FOR UPDATE
    `)
    const root = roots[0]
    if (roots.length !== 1 || !root || root.id !== owner.rootTaskId || root.sessionId !== owner.sessionId
      || root.turnId !== owner.turnId || root.rootTaskId !== owner.rootTaskId || root.parentTaskId !== null
      || root.attemptCount !== owner.rootAttemptCount || root.role !== 'orchestrator' || root.taskType !== 'root'
      || root.failureReason !== null || root.interruptRequestedAt != null || root.closedAt != null
      || !ROOT_STATUSES.has(String(root.status))) return null
    const children = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT "id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "depth", "role", "taskType", "status",
        "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "interruptRequestedAt", "closedAt",
        "failureReason", "context", "expectedOutputSchema", "allowedActions",
        ("leaseExpiresAt" > clock_timestamp()) AS "hasLiveLease"
      FROM "sub_agent_tasks" WHERE "id" = ${auditActor.taskId} AND "sessionId" = ${owner.sessionId}
        AND "turnId" = ${owner.turnId} AND "rootTaskId" = ${owner.rootTaskId} AND "parentTaskId" = ${owner.rootTaskId}
        AND "depth" = 1 AND "role" = 'auditor' AND "taskType" = ${AUDIT_TYPE} AND "status" = 'running'
        AND "attemptCount" = ${auditActor.attemptCount} AND "maxAttempts" >= ${auditActor.attemptCount}
        AND "leaseOwner" = ${auditActor.leaseOwner} AND "leaseExpiresAt" > clock_timestamp()
        AND "interruptRequestedAt" IS NULL AND "closedAt" IS NULL AND "failureReason" IS NULL
        AND "context" = '{}'::jsonb AND "expectedOutputSchema" = ${JSON.stringify(AUDIT_SCHEMA)}::jsonb
        AND "allowedActions" = '[]'::jsonb FOR UPDATE
    `)
    const child = children[0]
    if (children.length !== 1 || !child || child.hasLiveLease !== true || child.id !== auditActor.taskId
      || child.sessionId !== owner.sessionId || child.turnId !== owner.turnId || child.rootTaskId !== owner.rootTaskId
      || child.parentTaskId !== owner.rootTaskId || child.depth !== 1 || child.role !== 'auditor' || child.taskType !== AUDIT_TYPE
      || child.status !== 'running' || child.attemptCount !== auditActor.attemptCount || child.leaseOwner !== auditActor.leaseOwner
      || child.interruptRequestedAt != null || child.closedAt != null || child.failureReason !== null
      || !sameJson(child.context, {}) || !sameJson(child.expectedOutputSchema, AUDIT_SCHEMA) || !sameJson(child.allowedActions, [])) return null
    const dispatches = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
        AND "aggregateId" = ${owner.sessionId} AND "idempotencyKey" = ${`subagent-dispatch:${auditActor.taskId}`}
        AND "publishedAt" IS NOT NULL AND "payload"->>'taskId' = ${auditActor.taskId}
        AND "payload"->>'sessionId' = ${owner.sessionId} AND "payload"->>'rootTaskId' = ${owner.rootTaskId}
        AND length(COALESCE("payload"->>'ownerId', '')) > 0
    `)
    if (dispatches.length !== 1 || !dispatches[0]?.id) return null
    return { taskId: auditActor.taskId, attemptCount: auditActor.attemptCount, leaseOwner: auditActor.leaseOwner,
      rootStatus: String(root.status), turnStatus: String(turn.status) }
  } catch { return null }
}

export async function scheduledTaskGraphAuditChildFenceIsCurrent(tx: Prisma.TransactionClient,
  input: ScheduledTaskGraphAuditChildFenceInput): Promise<boolean> {
  return (await lockScheduledTaskGraphAuditChildFence(tx, input)) !== null
}

function validActor(value: unknown): value is ScheduledTaskGraphAuditActor {
  const row = record(value)
  return Boolean(row && exactKeys(row, ['taskId', 'attemptCount', 'leaseOwner']) && validId(row.taskId)
    && Number.isSafeInteger(row.attemptCount) && Number(row.attemptCount) > 0 && validId(row.leaseOwner))
}
function validOwner(value: unknown): value is ScheduledTaskGraphPipelineOwner {
  const row = record(value)
  return Boolean(row && exactKeys(row, ['userId', 'sessionId', 'turnId', 'rootTaskId', 'rootAttemptCount', 'turnLeaseOwnerId',
    'turnLeaseVersion', 'executionId', 'executionAttemptCount']) && validId(row.userId) && validId(row.sessionId)
    && validId(row.turnId) && validId(row.rootTaskId) && Number.isSafeInteger(row.rootAttemptCount) && Number(row.rootAttemptCount) > 0
    && validId(row.turnLeaseOwnerId) && Number.isSafeInteger(row.turnLeaseVersion) && Number(row.turnLeaseVersion) > 0
    && validId(row.executionId) && Number.isSafeInteger(row.executionAttemptCount) && Number(row.executionAttemptCount) >= 0)
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key))
}
function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value }
function sameJson(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)) } catch { return false }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  const row = record(value)
  return row ? Object.fromEntries(Object.keys(row).sort().map(key => [key, canonical(row[key])])) : value
}
