import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import type { ScheduledTaskGraphGateRequestOwner } from './scheduled-taskgraph-gate-rpc'
import type { ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import { scheduledTaskGraphGateApprovalWaitIds } from './scheduled-taskgraph-gate-approval-wait'

const WAIT_TIMEOUT_MS = 86_400_000
type Row = Record<string, unknown>
type RootAction = 'gate' | 'execute' | 'scheduled_audit_execute'
type RootTurn = Readonly<{ id: string; status: string; leaseOwnerId: string | null; leaseVersion: number; leaseExpiresAt: Date | null }>
type RootTask = Readonly<{ id: string; sessionId: string; turnId: string; rootTaskId: string; parentTaskId: string | null;
  status: string; attemptCount: number; interruptRequestedAt: Date | null; closedAt: Date | null; result: unknown }>
type LockedGateWait = Readonly<{ waitId: string; stepId: string; requestAttemptCount: number }>
export type ScheduledGateRootWaitLock = LockedGateWait & Readonly<{ approvalIds: readonly string[]; gateTaskId: string; owner: ScheduledTaskGraphGateRequestOwner;
  turn: RootTurn; root: Readonly<{ id: string; status: 'waiting'; attemptCount: number; waitId: string }> }>
export type ScheduledGateRootWait = Omit<ScheduledGateRootWaitLock, 'owner'> & Readonly<{ owner: ScheduledTaskGraphPipelineOwner }>
export type ScheduledTaskGraphRootActionLock = Readonly<{ root: RootTask; gateWait?: ScheduledGateRootWaitLock }>

/** Locks a scoped Root and, only for a Gate waiting Root, its exact durable dependency handoff. */
export async function lockScheduledTaskGraphRootAction(tx: Prisma.TransactionClient, input: {
  owner: ScheduledTaskGraphGateRequestOwner; action: RootAction; turn: RootTurn; gateTaskId?: string
}): Promise<ScheduledTaskGraphRootActionLock | null> {
  let gateWait: LockedGateWait | null = null
  if (input.action === 'gate') {
    if (!validId(input.gateTaskId)) return null
    const preview = await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`
      SELECT "status" FROM "sub_agent_tasks" WHERE "id" = ${input.owner.rootTaskId}
        AND "sessionId" = ${input.owner.sessionId} AND "turnId" = ${input.owner.turnId}
        AND "rootTaskId" = ${input.owner.rootTaskId} AND "parentTaskId" IS NULL
    `)
    if (preview.length !== 1 || !['running', 'waiting'].includes(preview[0]!.status)) return null
    if (preview[0]!.status === 'running' && input.turn.status === 'waiting_for_approval') return null
    if (preview[0]!.status === 'waiting') {
      if (input.turn.id !== input.owner.turnId
        || !['waiting_for_dependency', 'waiting_for_approval'].includes(input.turn.status)
        || input.turn.leaseOwnerId !== null || input.turn.leaseExpiresAt !== null
        || input.turn.leaseVersion !== input.owner.turnLeaseVersion) return null
      gateWait = await lockCurrentGateWait(tx, input.owner, input.gateTaskId)
      if (!gateWait) return null
    }
  }

  const rows = await tx.$queryRaw<RootTask[]>(Prisma.sql`
    SELECT "id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "status", "attemptCount",
      "interruptRequestedAt", "closedAt", "result"
    FROM "sub_agent_tasks" WHERE "id" = ${input.owner.rootTaskId} AND "sessionId" = ${input.owner.sessionId}
      AND "turnId" = ${input.owner.turnId} AND "rootTaskId" = ${input.owner.rootTaskId}
      AND "parentTaskId" IS NULL FOR UPDATE
  `)
  const root = rows[0]
  if (!root || rows.length !== 1 || root.id !== input.owner.rootTaskId || root.sessionId !== input.owner.sessionId
    || root.turnId !== input.owner.turnId || root.rootTaskId !== input.owner.rootTaskId || root.parentTaskId !== null
    || root.attemptCount !== input.owner.rootAttemptCount || root.interruptRequestedAt || root.closedAt) return null
  const allowed = input.action === 'scheduled_audit_execute' ? ['running', 'waiting']
    : input.action === 'gate' ? ['running', 'waiting'] : ['running']
  if (!allowed.includes(root.status)) return null
  if (input.action === 'gate' && (root.status === 'waiting'
    ? !gateWait || !rootWaitResultMatches(root.result, gateWait.waitId)
    : gateWait !== null)) return null
  let approvalIds: readonly string[] = []
  if (input.action === 'gate' && root.status === 'waiting' && input.turn.status === 'waiting_for_approval') {
    approvalIds = await scheduledTaskGraphGateApprovalWaitIds(tx, input.owner, input.gateTaskId!)
    if (approvalIds.length === 0) return null
  }
  const witness = gateWait ? { ...gateWait, approvalIds, gateTaskId: input.gateTaskId!, owner: input.owner, turn: {
    id: input.turn.id, status: input.turn.status, leaseOwnerId: input.turn.leaseOwnerId,
    leaseVersion: input.turn.leaseVersion, leaseExpiresAt: input.turn.leaseExpiresAt,
  },
    root: { id: root.id, status: 'waiting' as const, attemptCount: root.attemptCount, waitId: gateWait.waitId } } : undefined
  return { root, ...(witness ? { gateWait: witness } : {}) }
}

/** Binds a parked Root proof to the exact owner, released Turn, Root result, and locked Gate wait. */
export function scheduledGateRootWaitWitnessMatches(input: Readonly<{ owner: ScheduledTaskGraphPipelineOwner; gateTaskId: string;
  root: Readonly<{ id: unknown; status: unknown; attemptCount: unknown; result: unknown }>; witness?: ScheduledGateRootWait }>): boolean {
  const { owner, gateTaskId, root, witness } = input
  return !!witness && exactKeys(witness as unknown as Row, ['waitId', 'stepId', 'requestAttemptCount', 'approvalIds', 'gateTaskId', 'owner', 'turn', 'root'])
    && exactKeys(witness.owner as unknown as Row, ['userId', 'sessionId', 'turnId', 'rootTaskId', 'rootAttemptCount',
      'turnLeaseOwnerId', 'turnLeaseVersion', 'executionId', 'executionAttemptCount'])
    && exactKeys(witness.turn as unknown as Row, ['id', 'status', 'leaseOwnerId', 'leaseVersion', 'leaseExpiresAt'])
    && exactKeys(witness.root as unknown as Row, ['id', 'status', 'attemptCount', 'waitId'])
    && validId(gateTaskId) && validId(witness.waitId) && validId(witness.stepId)
    && nonNegative(witness.requestAttemptCount) && witness.requestAttemptCount < Number.MAX_SAFE_INTEGER
    && witness.gateTaskId === gateTaskId && sameOwner(witness.owner, owner)
    && witness.turn.id === owner.turnId
    && (witness.turn.status === 'waiting_for_dependency' ? validApprovalIds(witness.approvalIds, false)
      : witness.turn.status === 'waiting_for_approval' && validApprovalIds(witness.approvalIds, true))
    && witness.turn.leaseOwnerId === null && witness.turn.leaseExpiresAt === null
    && witness.turn.leaseVersion === owner.turnLeaseVersion
    && witness.root.id === owner.rootTaskId && witness.root.status === 'waiting'
    && witness.root.attemptCount === owner.rootAttemptCount && witness.root.waitId === witness.waitId
    && root.id === witness.root.id && root.status === 'waiting' && root.attemptCount === witness.root.attemptCount
    && rootWaitResultMatches(root.result, witness.waitId)
}

/** Call only after the current canonical Gate history proof has passed in this transaction. */
export async function scheduledGateWaitAttemptMatchesCurrentHistory(tx: Prisma.TransactionClient,
  owner: ScheduledTaskGraphGateRequestOwner, gateTaskId: string, requestAttemptCount: number): Promise<boolean> {
  if (!validId(gateTaskId) || !nonNegative(requestAttemptCount) || requestAttemptCount === Number.MAX_SAFE_INTEGER) return false
  const graphId = taskGraphItemId(owner.rootTaskId)
  const rows = await tx.$queryRaw<Array<{ event: unknown }>>(Prisma.sql`
    SELECT "payload"->'event' AS "event" FROM "agent_events"
    WHERE "sessionId" = ${owner.sessionId} AND "turnId" = ${owner.turnId} AND "itemId" = ${graphId}
      AND "taskId" = ${owner.rootTaskId} AND "type" = 'item.delta' AND "actor" = 'system'
      AND "payload"->>'kind' = 'lifecycle' AND "payload"->'event'->>'nodeKey' = 'gate'
      AND "payload"->'event'->>'type' = 'task.gate_choice_resumed'
    ORDER BY "sequence" DESC LIMIT 1
  `)
  if (requestAttemptCount === 0) return rows.length === 0
  const event = record(rows[0]?.event)
  return rows.length === 1 && !!event && exactKeys(event, ['type', 'idempotencyKey', 'expectedRevision', 'nodeKey',
    'gateTaskId', 'requestAttemptCount', 'resumedAttemptCount'])
    && event.type === 'task.gate_choice_resumed' && event.nodeKey === 'gate' && event.gateTaskId === gateTaskId
    && event.requestAttemptCount === requestAttemptCount && event.resumedAttemptCount === requestAttemptCount + 1
    && Number.isSafeInteger(event.expectedRevision) && Number(event.expectedRevision) >= 0
    && event.idempotencyKey === lifecycleKey(owner.rootTaskId, requestAttemptCount)
}

async function lockCurrentGateWait(tx: Prisma.TransactionClient, owner: ScheduledTaskGraphGateRequestOwner,
  gateTaskId: string): Promise<LockedGateWait | null> {
  const rows = await tx.$queryRaw<Row[]>(Prisma.sql`
    SELECT "id", "userId", "sessionId", "turnId", "parentTaskId", "stepId", "idempotencyKey", "targetTaskIds",
      "mode", "status", "matchedTaskIds", "result", "suspendedAt", "consumedAt"
    FROM "agent_wait_conditions" WHERE "userId" = ${owner.userId} AND "sessionId" = ${owner.sessionId}
      AND "turnId" = ${owner.turnId} AND "parentTaskId" = ${owner.rootTaskId}
      AND "status" = 'waiting' AND "consumedAt" IS NULL
    ORDER BY "createdAt" ASC, "id" ASC LIMIT 2 FOR UPDATE
  `)
  if (rows.length !== 1) return null
  const wait = rows[0]!, waitId = wait.id, stepId = wait.stepId
  if (!validId(waitId) || !validId(stepId) || wait.userId !== owner.userId || wait.sessionId !== owner.sessionId
    || wait.turnId !== owner.turnId || wait.parentTaskId !== owner.rootTaskId || wait.status !== 'waiting'
    || wait.suspendedAt === null || wait.suspendedAt === undefined || wait.consumedAt !== null
    || wait.mode !== 'any' || !sameJson(parseJson(wait.targetTaskIds), [gateTaskId])
    || !sameJson(parseJson(wait.matchedTaskIds), [])) return null
  const result = record(wait.result), request = record(result?.request), marker = record(request?.scheduledGate)
  if (!result || !exactKeys(result, ['request']) || !request
    || !exactKeys(request, ['targetTaskIds', 'mode', 'timeoutMs', 'scheduledGate'])
    || !sameJson(request.targetTaskIds, [gateTaskId]) || request.mode !== 'any' || request.timeoutMs !== WAIT_TIMEOUT_MS
    || !marker || !exactKeys(marker, ['gateTaskId', 'requestAttemptCount']) || marker.gateTaskId !== gateTaskId
    || !nonNegative(marker.requestAttemptCount) || marker.requestAttemptCount === Number.MAX_SAFE_INTEGER
    || wait.idempotencyKey !== waitKey(gateTaskId, stepId, Number(marker.requestAttemptCount))) return null
  const steps = await tx.$queryRaw<Array<{ id: string; taskId: string | null; attempt: number; status: string }>>(Prisma.sql`
    SELECT "id", "taskId", "attempt", "status" FROM "agent_steps"
    WHERE "id" = ${stepId} AND "sessionId" = ${owner.sessionId} AND "turnId" = ${owner.turnId}
      AND ("taskId" = ${owner.rootTaskId} OR "taskId" IS NULL) FOR SHARE
  `)
  const step = steps[0]
  if (steps.length !== 1 || !step || step.id !== stepId || step.status !== 'waiting_for_tool' || step.attempt !== 1
    || step.taskId !== owner.rootTaskId && step.taskId !== null) return null
  return { waitId, stepId, requestAttemptCount: Number(marker.requestAttemptCount) }
}

function rootWaitResultMatches(value: unknown, waitId: string): boolean {
  const result = record(value)
  return !!result && exactKeys(result, ['status', 'stepCount', 'toolCallCount', 'finalItemId', 'waitId'])
    && result.status === 'waiting_for_dependency' && result.waitId === waitId
    && nonNegative(result.stepCount) && nonNegative(result.toolCallCount)
    && (result.finalItemId === null || validId(result.finalItemId))
}
function waitKey(gateTaskId: string, stepId: string, requestAttemptCount: number): string {
  const digest = createHash('sha256').update(JSON.stringify([gateTaskId, stepId, requestAttemptCount]), 'utf8').digest('hex')
  return `scheduled-gate-wait:${digest}`
}
function lifecycleKey(rootTaskId: string, attempt: number): string {
  const node = createHash('sha256').update('gate').digest('hex').slice(0, 20)
  return `${taskGraphItemId(rootTaskId)}:node:${node}:${attempt}:task.gate_choice_resumed`
}
function taskGraphItemId(rootTaskId: string): string { return `task-graph-${createHash('sha256').update(rootTaskId).digest('hex')}` }
function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) as unknown } catch { return null }
}
function record(value: unknown): Row | null {
  const parsed = parseJson(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const prototype = Object.getPrototypeOf(parsed)
  return prototype === Object.prototype || prototype === null ? parsed as Row : null
}
function exactKeys(value: Row, keys: readonly string[]): boolean { return Object.keys(value).sort().join(',') === [...keys].sort().join(',') }
function sameOwner(left: ScheduledTaskGraphPipelineOwner, right: ScheduledTaskGraphPipelineOwner): boolean {
  return left.userId === right.userId && left.sessionId === right.sessionId && left.turnId === right.turnId
    && left.rootTaskId === right.rootTaskId && left.rootAttemptCount === right.rootAttemptCount
    && left.turnLeaseOwnerId === right.turnLeaseOwnerId && left.turnLeaseVersion === right.turnLeaseVersion
    && left.executionId === right.executionId && left.executionAttemptCount === right.executionAttemptCount
}
function sameJson(left: unknown, right: unknown): boolean { try { return JSON.stringify(left) === JSON.stringify(right) } catch { return false } }
function validId(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)
}
function nonNegative(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function validApprovalIds(value: unknown, required: boolean): value is readonly string[] {
  if (!Array.isArray(value) || value.length > 50 || (required ? value.length === 0 : value.length !== 0)
    || !value.every(validId) || new Set(value).size !== value.length) return false
  return value.every((id, index) => index === 0 || value[index - 1]! < id)
}
