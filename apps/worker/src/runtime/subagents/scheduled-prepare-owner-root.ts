import type pg from "pg"
import { parseTerminalRootResult } from "./root-task-terminal-result.js"
import { SCHEDULED_AUDIT_ROLE, SCHEDULED_AUDIT_TASK_TYPE } from "./scheduled-audit-contract.js"
import type { ScheduledTaskGraphContinuationReceipt } from "./scheduled-taskgraph-continuation-receipt.js"
import type { ScheduledAutomationPersistedRoot } from "./scheduled-automation-pipeline-bridge.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type Owner = Pick<ScheduledTaskGraphContinuationReceipt["owner"], "userId" | "sessionId" | "turnId" | "rootTaskId" | "rootAttemptCount">
type Scope = Pick<Owner, "userId" | "sessionId" | "turnId" | "rootTaskId">
type Task = Readonly<{ id: string; role: string; taskType?: string; status: string; attemptCount?: number; failureReason: string | null }>
type Mode = "finish" | "persisted_gate"

/** Preserves live registration checks and accepts only a root parked on this graph's running Audit child. */
export async function scheduledPrepareReceiptOwnerRootMatches(client: Client, scope: Scope, owner: Owner,
  mode: Mode, tasks: ReadonlyMap<string, Task>): Promise<ScheduledAutomationPersistedRoot | null> {
  if (owner.userId !== scope.userId || owner.sessionId !== scope.sessionId || owner.turnId !== scope.turnId || owner.rootTaskId !== scope.rootTaskId) return null
  const rows = await client.query<Row>(`SELECT task."id", session."userId" AS "userId", task."sessionId", task."turnId", task."status", task."attemptCount",
      task."result", task."failureReason", turn."status" AS "turnStatus", turn."leaseOwnerId" AS "turnLeaseOwnerId", turn."leaseExpiresAt" AS "turnLeaseExpiresAt"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $1 AND task."parentTaskId" IS NULL
      AND task."taskType" = 'root' AND turn."rootTaskId" = $1 AND turn."userId" = $4 AND session."userId" = $4`,
  [owner.rootTaskId, scope.sessionId, scope.turnId, scope.userId])
  const row = asRecord(rows.rows[0])
  if (rows.rows.length !== 1 || !row || row.id !== owner.rootTaskId || row.userId !== scope.userId || row.sessionId !== scope.sessionId
    || row.turnId !== scope.turnId || Number(row.attemptCount) !== owner.rootAttemptCount) return null
  if (row.status === "running") return root(owner, scope, "running")
  if (mode !== "persisted_gate" || row.status !== "waiting" || row.failureReason !== null
    || row.turnStatus !== "waiting_for_dependency" || row.turnLeaseOwnerId !== null || row.turnLeaseExpiresAt !== null) return null
  const result = asRecord(row.result)
  if (!result || !exact(result, ["status", "stepCount", "toolCallCount", "finalItemId", "waitId"]) || result.finalItemId !== null) return null
  let parsed: ReturnType<typeof parseTerminalRootResult>
  try { parsed = parseTerminalRootResult({ id: row.id, status: row.status, result: row.result, failureReason: row.failureReason }) } catch { return null }
  if (parsed.result.status !== "waiting_for_dependency" || !parsed.result.waitId) return null
  const audits = [...tasks.values()].filter(task => task.role === SCHEDULED_AUDIT_ROLE && task.taskType === SCHEDULED_AUDIT_TASK_TYPE
    && task.status === "running" && task.failureReason === null && Number.isSafeInteger(task.attemptCount) && Number(task.attemptCount) > 0)
  if (audits.length !== 1 || !validId(audits[0]!.id)) return null
  return await parkedAuditWaitMatches(client, scope, owner.rootTaskId, owner.rootAttemptCount, parsed.result.waitId, audits[0]!)
    ? root(owner, scope, "waiting") : null
}

async function parkedAuditWaitMatches(client: Client, scope: Scope, rootTaskId: string, rootAttemptCount: number,
  waitId: string, audit: Task): Promise<boolean> {
  const rows = await client.query<Row>(`SELECT wait."id", wait."userId", wait."sessionId", wait."turnId", wait."parentTaskId", wait."stepId",
      wait."targetTaskIds", wait."mode", wait."status", wait."result", wait."suspendedAt", wait."resolvedAt", wait."consumedAt",
      parent."status" AS "parentStatus", parent."attemptCount" AS "parentAttemptCount", parent."result" AS "parentResult",
      parent."failureReason" AS "parentFailureReason", turn."status" AS "turnStatus", turn."leaseOwnerId" AS "turnLeaseOwnerId",
      turn."leaseExpiresAt" AS "turnLeaseExpiresAt",
      step."taskId" AS "stepTaskId", step."attempt" AS "stepAttempt", step."status" AS "stepStatus",
      target."id" AS "targetTaskId", target."rootTaskId" AS "targetRootTaskId", target."parentTaskId" AS "targetParentTaskId",
      target."sessionId" AS "targetSessionId", target."turnId" AS "targetTurnId", target."role" AS "targetRole",
      target."taskType" AS "targetTaskType", target."status" AS "targetStatus", target."attemptCount" AS "targetAttemptCount", target."failureReason" AS "targetFailureReason"
    FROM "agent_wait_conditions" AS wait
    JOIN "agent_sessions" AS session ON session."id" = wait."sessionId" AND session."userId" = wait."userId"
    JOIN "agent_turns" AS turn ON turn."id" = wait."turnId" AND turn."sessionId" = wait."sessionId"
      AND turn."userId" = wait."userId" AND turn."rootTaskId" = $4 AND turn."status" = 'waiting_for_dependency'
      AND turn."leaseOwnerId" IS NULL AND turn."leaseExpiresAt" IS NULL
    JOIN "sub_agent_tasks" AS parent ON parent."id" = wait."parentTaskId" AND parent."id" = $4
      AND parent."sessionId" = wait."sessionId" AND parent."turnId" = wait."turnId" AND parent."rootTaskId" = $4
      AND parent."parentTaskId" IS NULL AND parent."taskType" = 'root' AND parent."status" = 'waiting'
      AND parent."attemptCount" = $10 AND parent."failureReason" IS NULL
    JOIN "agent_steps" AS step ON step."id" = wait."stepId" AND step."sessionId" = wait."sessionId" AND step."turnId" = wait."turnId"
    JOIN "sub_agent_tasks" AS target ON target."id" = $6 AND wait."targetTaskIds" @> jsonb_build_array(target."id")
      AND target."sessionId" = wait."sessionId" AND target."turnId" = wait."turnId" AND target."rootTaskId" = $4
      AND target."parentTaskId" = $4 AND target."role" = $7 AND target."taskType" = $8
    WHERE wait."id" = $1 AND wait."userId" = $2 AND wait."sessionId" = $3 AND wait."turnId" = $5
      AND wait."parentTaskId" = $4 AND step."attempt" = 1 AND (step."taskId" = $4 OR step."taskId" IS NULL)
      AND step."status" = 'waiting_for_tool' AND target."status" = 'running' AND target."attemptCount" = $9
      AND target."failureReason" IS NULL`,
  [waitId, scope.userId, scope.sessionId, rootTaskId, scope.turnId, audit.id, SCHEDULED_AUDIT_ROLE, SCHEDULED_AUDIT_TASK_TYPE,
    audit.attemptCount, rootAttemptCount])
  if (rows.rows.length !== 1) return false
  const row = asRecord(rows.rows[0]), targets = stringArray(row?.targetTaskIds), result = asRecord(row?.result), request = asRecord(result?.request)
  const requestTargets = stringArray(request?.targetTaskIds)
  const parentResult = asRecord(row?.parentResult)
  let currentWaitId: string | undefined
  try {
    const current = parseTerminalRootResult({ id: rootTaskId, status: row?.parentStatus, result: row?.parentResult,
      failureReason: row?.parentFailureReason }).result
    if (current.status === "waiting_for_dependency") currentWaitId = current.waitId
  } catch { return false }
  if (!parentResult || !exact(parentResult, ["status", "stepCount", "toolCallCount", "finalItemId", "waitId"])) return false
  return !!row && row.id === waitId && row.userId === scope.userId && row.sessionId === scope.sessionId && row.turnId === scope.turnId
    && row.parentStatus === "waiting" && Number(row.parentAttemptCount) === rootAttemptCount && row.parentFailureReason === null
    && row.turnStatus === "waiting_for_dependency" && row.turnLeaseOwnerId === null && row.turnLeaseExpiresAt === null && currentWaitId === waitId
    && row.parentTaskId === rootTaskId && validId(row.stepId) && row.stepAttempt === 1 && row.stepStatus === "waiting_for_tool"
    && (row.stepTaskId === null || row.stepTaskId === rootTaskId) && row.mode === "all" && row.status === "waiting"
    && timestamp(row.suspendedAt) && row.resolvedAt === null && row.consumedAt === null && sameOne(targets, audit.id)
    && exact(result, ["request"]) && exact(request, ["targetTaskIds", "mode", "timeoutMs"])
    && sameOne(requestTargets, audit.id) && request?.mode === "all" && Number.isSafeInteger(request.timeoutMs)
    && Number(request.timeoutMs) > 0 && Number(request.timeoutMs) <= 86_400_000
    && row.targetTaskId === audit.id && row.targetRootTaskId === rootTaskId && row.targetParentTaskId === rootTaskId
    && row.targetSessionId === scope.sessionId && row.targetTurnId === scope.turnId && row.targetRole === SCHEDULED_AUDIT_ROLE
    && row.targetTaskType === SCHEDULED_AUDIT_TASK_TYPE && row.targetStatus === "running"
    && Number(row.targetAttemptCount) === Number(audit.attemptCount) && row.targetFailureReason === null
}

function root(owner: Owner, scope: Scope, status: "running" | "waiting"): ScheduledAutomationPersistedRoot {
  return { id: owner.rootTaskId, userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, status, attemptCount: owner.rootAttemptCount }
}
function asRecord(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Row : null } catch { return null }
}
function exact(value: Row | null, keys: readonly string[]): value is Row {
  const actual = value && Reflect.ownKeys(value)
  return !!actual && actual.length === keys.length && actual.every(key => typeof key === "string" && keys.includes(key))
}
function stringArray(value: unknown): string[] | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return Array.isArray(parsed) && parsed.every(validId) ? parsed : null
}
function sameOne(values: string[] | null, id: string): boolean { return values?.length === 1 && values[0] === id }
function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) }
function timestamp(value: unknown): boolean { return value instanceof Date ? Number.isFinite(value.getTime()) : typeof value === "string" && Number.isFinite(Date.parse(value)) }
