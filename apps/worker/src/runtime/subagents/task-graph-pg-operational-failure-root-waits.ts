import type pg from "pg"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"
import type { TaskGraphOperationalFailedBranchRelation } from "./task-graph-pg-operational-failed-branch-relation.js"
import { taskGraphLifecycleKey } from "./task-graph-snapshot.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type OperationCancellation = TaskGraphOperationalFailedBranchRelation["cancellations"][number]
type Input = Readonly<{ scope: GraphIdentityScope; taskIds: readonly string[]; operationCancellations?: readonly OperationCancellation[] }>
type WaitShape = Readonly<{ targets: readonly string[]; matched: readonly string[]; mode: "all" | "any"; timeoutMs: number }>
const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "closed"])
const TASK_STATUSES = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user", ...TERMINAL])
const SELECTED_STATUSES = new Set(["queued", "waiting", "cancelled"])
const PREREQUISITE_FAILURE = "A prerequisite task did not complete."

function record(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Row : null } catch { return null }
}
function exact(row: Row | null, keys: readonly string[]): row is Row {
  return row !== null && Reflect.ownKeys(row).length === keys.length && Reflect.ownKeys(row).every(key => typeof key === "string" && keys.includes(key))
}
function id(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value }
function timestamp(value: unknown): number | null {
  const parsed = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}
function strings(value: unknown): string[] | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return Array.isArray(parsed) && parsed.every(item => id(item)) ? parsed as string[] : null
}
function sortedIds(value: unknown): string[] | null {
  const parsed = strings(value)
  return parsed && new Set(parsed).size === parsed.length && parsed.every((item, index) => index === 0 || parsed[index - 1]! < item) ? parsed : null
}
function operationCancellationIds(value: unknown, selected: ReadonlySet<string>, rootTaskId: string): Set<string> | null {
  if (value === undefined) return new Set()
  if (!Array.isArray(value) || value.length > 8) return null
  const result = new Set<string>()
  for (const raw of value) {
    const entry = record(raw), source = record(entry?.source), event = record(entry?.event)
    if (!exact(entry, ["source", "event"]) || !exact(source, ["nodeKey", "taskId"])
      || !id(source.nodeKey) || !id(source.taskId) || !selected.has(source.taskId) || result.has(source.taskId)
      || !exact(event, ["id", "sequence", "idempotencyKey"]) || !id(event.id)
      || typeof event.sequence !== "string" || !/^[1-9][0-9]{0,18}$/.test(event.sequence)
      || BigInt(event.sequence) > 9_223_372_036_854_775_807n
      || event.idempotencyKey !== taskGraphLifecycleKey(rootTaskId, source.nodeKey, 0, "task.cancelled")) return null
    result.add(source.taskId)
  }
  return result
}
function request(wait: Row): WaitShape | null {
  const targets = sortedIds(wait.targetTaskIds), matched = sortedIds(wait.matchedTaskIds), result = record(wait.result)
  const body = record(result?.request)
  if (!targets || !matched || targets.length === 0 || targets.length > 8 || matched.some(id => !targets.includes(id))
    || !exact(result, ["request"]) && !exact(result, ["request", "outcome"]) || !exact(body, ["targetTaskIds", "mode", "timeoutMs"])
    || !sameIds(sortedIds(body.targetTaskIds) ?? [], targets) || body.mode !== wait.mode
    || (body.mode !== "all" && body.mode !== "any") || !Number.isSafeInteger(body.timeoutMs)
    || Number(body.timeoutMs) < 1 || Number(body.timeoutMs) > 86_400_000) return null
  return { targets, matched, mode: body.mode, timeoutMs: Number(body.timeoutMs) }
}
function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
function lineage(wait: Row, scope: GraphIdentityScope, shape: WaitShape): boolean {
  const created = timestamp(wait.createdAt), deadline = timestamp(wait.deadlineAt)
  return wait.parentTaskId === scope.rootTaskId && wait.userId === scope.userId && wait.sessionUserId === scope.userId
    && wait.sessionId === scope.sessionId && wait.turnId === scope.turnId && id(wait.id) && id(wait.stepId) && id(wait.idempotencyKey)
    && wait.parentId === scope.rootTaskId && wait.parentSessionId === scope.sessionId && wait.parentTurnId === scope.turnId
    && (wait.parentRootTaskId === null || wait.parentRootTaskId === undefined || wait.parentRootTaskId === scope.rootTaskId)
    && wait.parentParentTaskId === null && wait.parentRole === "orchestrator" && wait.parentTaskType === "root"
    && wait.turnUserId === scope.userId && (wait.turnRootTaskId === null || wait.turnRootTaskId === undefined || wait.turnRootTaskId === scope.rootTaskId)
    && (wait.stepTaskId === scope.rootTaskId || wait.stepTaskId === null) && Number(wait.stepAttempt) === 1
    && wait.resolvedStepId === wait.stepId && created !== null && deadline !== null && deadline - created === shape.timeoutMs
}
function validTargetRows(shape: WaitShape, rows: ReadonlyMap<string, Row>, selected: ReadonlySet<string>, operationCancellations: ReadonlySet<string>): boolean {
  if (shape.targets.some(id => !rows.has(id))) return false
  for (const taskId of shape.targets) {
    const row = rows.get(taskId)!
    if (typeof row.role !== "string" || row.role.length === 0 || row.role.length > 256 || !TASK_STATUSES.has(String(row.status))) return false
    if (selected.has(taskId) && !validSelectedTarget(row, operationCancellations.has(taskId))) return false
  }
  return true
}
function validSelectedTarget(row: Row, operationCancelled: boolean): boolean {
  if (!SELECTED_STATUSES.has(String(row.status)) || Number(row.attemptCount) !== 0
    || row.startedAt !== null || row.leaseOwner !== null || row.leaseExpiresAt !== null || row.nextAttemptAt !== null
    || row.closedAt !== null || row.interruptRequestedAt !== null || row.result !== null || row.confidence !== null
    || row.qualityGateResult !== null || row.contextSnapshotId !== null || !Array.isArray(row.outputArtifactIds)
    || row.outputArtifactIds.length !== 0 || row.hasCanonicalDispatch !== false) return false
  if (row.status === "cancelled") return timestamp(row.completedAt) !== null
    && (operationCancelled ? row.failureReason === null : row.failureReason === PREREQUISITE_FAILURE)
  return row.failureReason === null && row.completedAt === null
}
function validOutcomeTasks(value: unknown, shape: WaitShape, rows: ReadonlyMap<string, Row>, selected: ReadonlySet<string>): boolean {
  if (!Array.isArray(value) || value.length !== shape.targets.length) return false
  return value.every((raw, index) => {
    const task = record(raw), taskId = shape.targets[index]!, row = rows.get(taskId)
    const keys = task ? ["taskId", "status", "role", "result", "failureReason",
      ...(Object.hasOwn(task, "verificationReport") ? ["verificationReport"] : []),
      ...(Object.hasOwn(task, "repairReceipt") ? ["repairReceipt"] : [])] : []
    const selectedObservation = !!task && (!selected.has(taskId) || (SELECTED_STATUSES.has(String(task.status))
      && task.result === null && (task.status === "cancelled"
        ? task.failureReason === null || task.failureReason === PREREQUISITE_FAILURE : task.failureReason === null)
      && (!Object.hasOwn(task, "verificationReport") || task.verificationReport === null)
      && (!Object.hasOwn(task, "repairReceipt") || task.repairReceipt === null)))
    return !!task && !!row && exact(task, keys) && task.taskId === taskId && task.role === row.role
      && TASK_STATUSES.has(String(task.status)) && (task.failureReason === null || typeof task.failureReason === "string")
      && (task.status === "failed" || task.failureReason === null
        || selected.has(taskId) && task.status === "cancelled" && task.failureReason === PREREQUISITE_FAILURE)
      && (task.status === "completed" || task.result === null)
      && (!Object.hasOwn(task, "verificationReport") || record(task.verificationReport) !== null)
      && (!Object.hasOwn(task, "repairReceipt") || record(task.repairReceipt) !== null)
      && selectedObservation
  })
}
function matchedOutcomeIsTerminal(value: unknown, matched: readonly string[]): boolean {
  if (!Array.isArray(value)) return false
  const byId = new Map(value.map(raw => { const task = record(raw); return [String(task?.taskId), task] as const }))
  return matched.every(taskId => TERMINAL.has(String(byId.get(taskId)?.status)))
}
function validWait(wait: Row, scope: GraphIdentityScope, shape: WaitShape, rows: ReadonlyMap<string, Row>, selected: ReadonlySet<string>,
  operationCancellations: ReadonlySet<string>): boolean {
  if (!lineage(wait, scope, shape) || !validTargetRows(shape, rows, selected, operationCancellations)) return false
  const result = record(wait.result)!, resolved = timestamp(wait.resolvedAt), suspended = timestamp(wait.suspendedAt), consumed = timestamp(wait.consumedAt)
  if (wait.status === "ready" && suspended === null && resolved === null && consumed === null && exact(result, ["request"])) {
    return shape.matched.length > 0
      && shape.matched.every(taskId => TERMINAL.has(String(rows.get(taskId)?.status)))
      && (shape.mode === "any" || sameIds(shape.matched, shape.targets))
  }
  if ((wait.status !== "ready" && wait.status !== "timed_out") || suspended === null || resolved === null || consumed === null
    || resolved < timestamp(wait.createdAt)! || suspended < timestamp(wait.createdAt)! || consumed < Math.max(resolved, suspended)
    || !exact(result, ["request", "outcome"])) return false
  if (wait.status === "ready" && (shape.matched.length === 0 || shape.mode === "all" && !sameIds(shape.matched, shape.targets))) return false
  const outcome = record(result.outcome)
  return exact(outcome, ["waitId", "status", "matchedTaskIds", "targetTaskIds", "tasks"]) && outcome.waitId === wait.id
    && outcome.status === wait.status && sameIds(sortedIds(outcome.targetTaskIds) ?? [], shape.targets)
    && sameIds(sortedIds(outcome.matchedTaskIds) ?? [], shape.matched) && matchedOutcomeIsTerminal(outcome.tasks, shape.matched)
    && validOutcomeTasks(outcome.tasks, shape, rows, selected)
}

/** Validates Root-owned wait observations that reference selected graph tasks; it grants no task or result authority. */
export async function proveTaskGraphOperationalRootWaitReferences(client: Client, input: Input): Promise<boolean> {
  const { scope } = input, taskIds = [...new Set(input.taskIds)]
  if (!id(scope.userId) || !id(scope.sessionId) || !id(scope.turnId) || !id(scope.rootTaskId)
    || scope.parentTaskId !== scope.rootTaskId || taskIds.length !== input.taskIds.length || taskIds.some(value => !id(value))) return false
  const selected = new Set(taskIds), operationCancellations = operationCancellationIds(input.operationCancellations, selected, scope.rootTaskId)
  if (!operationCancellations) return false
  if (taskIds.length === 0) return true
  const waits = await client.query<Row>(`SELECT wait."id", wait."userId", wait."sessionId", wait."turnId", wait."parentTaskId", wait."stepId", wait."idempotencyKey",
      wait."targetTaskIds", wait."mode", wait."status", wait."matchedTaskIds", wait."result", wait."createdAt", wait."deadlineAt", wait."resolvedAt", wait."suspendedAt", wait."consumedAt",
      session."userId" AS "sessionUserId", parent."id" AS "parentId", parent."sessionId" AS "parentSessionId", parent."turnId" AS "parentTurnId",
      parent."rootTaskId" AS "parentRootTaskId", parent."parentTaskId" AS "parentParentTaskId", parent."role" AS "parentRole", parent."taskType" AS "parentTaskType",
      turn."userId" AS "turnUserId", turn."rootTaskId" AS "turnRootTaskId", step."id" AS "resolvedStepId", step."taskId" AS "stepTaskId", step."attempt" AS "stepAttempt"
    FROM "agent_wait_conditions" wait LEFT JOIN "agent_sessions" session ON session."id" = wait."sessionId"
    LEFT JOIN "agent_turns" turn ON turn."id" = wait."turnId" AND turn."sessionId" = wait."sessionId"
    LEFT JOIN "sub_agent_tasks" parent ON parent."id" = wait."parentTaskId" AND parent."sessionId" = wait."sessionId"
    LEFT JOIN "agent_steps" step ON step."id" = wait."stepId" AND step."sessionId" = wait."sessionId" AND step."turnId" = wait."turnId"
    WHERE wait."parentTaskId" = ANY($1::text[]) OR wait."targetTaskIds" ?| $1::text[] OR wait."matchedTaskIds" ?| $1::text[]`, [taskIds])
  if (waits.rows.length === 0) return true
  const parsed = waits.rows.map(wait => ({ wait, shape: request(wait) }))
  if (parsed.some(item => !item.shape)) return false
  const targetIds = [...new Set(parsed.flatMap(item => item.shape!.targets))]
  const targets = await client.query<Row>(`SELECT task."id", task."rootTaskId", task."sessionId", task."turnId", task."status", task."role", task."attemptCount", task."failureReason", task."startedAt", task."leaseOwner", task."leaseExpiresAt", task."nextAttemptAt", task."completedAt", task."closedAt", task."interruptRequestedAt", task."result", task."confidence", task."qualityGateResult", task."contextSnapshotId", task."outputArtifactIds",
      EXISTS (SELECT 1 FROM "agent_outbox" dispatch WHERE dispatch."topic" = 'agent.subagent.dispatch'
        AND dispatch."aggregateId" = task."sessionId" AND dispatch."idempotencyKey" = 'subagent-dispatch:' || task."id"
        AND dispatch."payload"->>'taskId' = task."id" AND dispatch."payload"->>'sessionId' = task."sessionId"
        AND dispatch."payload"->>'rootTaskId' = task."rootTaskId") AS "hasCanonicalDispatch", session."userId" AS "userId"
    FROM "sub_agent_tasks" task JOIN "agent_sessions" session ON session."id" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4 AND session."userId" = $5`,
  [targetIds, scope.sessionId, scope.turnId, scope.rootTaskId, scope.userId])
  const rows = new Map(targets.rows.map(row => [String(row.id), row]))
  if (rows.size !== targetIds.length || targets.rows.some(row => row.sessionId !== scope.sessionId || row.turnId !== scope.turnId
    || String(row.rootTaskId) !== scope.rootTaskId || row.userId !== scope.userId)) return false
  return parsed.every(item => validWait(item.wait, scope, item.shape!, rows, selected, operationCancellations))
}
