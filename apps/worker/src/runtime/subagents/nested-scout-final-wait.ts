import type pg from "pg"
import { isProxy } from "node:util/types"
import type { PrepareFinalDependencyWait, PrepareFinalDependencyWaitInput } from "../turns/turn-execution-options.js"
import type { ContextBlock } from "../context/step-context-builder.js"
import { nestedScoutTaskScopeFromContext, type NestedScoutChildRow } from "./nested-scout-tools.js"
import { nestedScoutProfileForTask } from "./nested-scout-profile.js"
import type { SubagentLease } from "./types.js"

const ACTIVE = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user"])
const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "closed"])
const KNOWN = new Set([...ACTIVE, ...TERMINAL])
type WaitRow = Record<string, unknown>
type Client = Pick<pg.PoolClient, "query" | "release">

export function createNestedScoutFinalWait(options: { readonly pool: Pick<pg.Pool, "connect">; readonly lease: SubagentLease }): PrepareFinalDependencyWait {
  return async input => {
    if (input.signal.aborted) return null
    if (!isCurrentNestedScout(input, options.lease)) throw new Error("nested_scout_final_wait_owner_unavailable")
    const children = await readCurrentChildren(options.pool, input, options.lease)
    if (input.signal.aborted) return null
    return prepareNestedScoutFinalWait(input, options.lease, children)
  }
}

export function prepareNestedScoutFinalWait(input: PrepareFinalDependencyWaitInput, lease: SubagentLease,
  children: readonly NestedScoutChildRow[]): Readonly<{ taskIds: readonly string[] }> | null {
  if (input.signal.aborted) return null
  if (!isCurrentNestedScout(input, lease)) throw new Error("nested_scout_final_wait_owner_unavailable")
  if (children.length > 2 || children.some(child => !safeId(child.taskId) || !KNOWN.has(child.status)
    || child.role !== "scout" || child.taskType !== "job_discovery" || !nestedScoutTaskScopeFromContext(child.context))) {
    throw new Error("nested_scout_final_wait_children_invalid")
  }
  const taskIds = children.map(child => child.taskId).sort((left, right) => left.localeCompare(right))
  if (new Set(taskIds).size !== taskIds.length) throw new Error("nested_scout_final_wait_children_invalid")
  if (taskIds.length === 0) return null
  if (children.some(child => ACTIVE.has(child.status))) return Object.freeze({ taskIds: Object.freeze(taskIds) })
  if (hasDeliveredWaitOutcome(input, taskIds)) return null
  return Object.freeze({ taskIds: Object.freeze(taskIds) })
}

function isCurrentNestedScout(input: PrepareFinalDependencyWaitInput, lease: SubagentLease): boolean {
  const identity = input.identity
  return nestedScoutProfileForTask(lease) !== null && identity.kind === "task"
    && identity.userId === lease.userId && identity.sessionId === lease.sessionId && identity.turnId === lease.turnId
    && identity.taskId === lease.id && identity.rootTaskId === lease.rootTaskId && identity.ownerId === lease.ownerId
    && identity.attemptCount === lease.attemptCount && lease.status === "running" && lease.interruptRequestedAt === null
    && lease.leaseOwner === lease.ownerId && lease.ownerId.trim().length > 0 && !!lease.turnId
    && input.signal === lease.signal && input.context.schemaVersion === "agent-harness.v2"
    && input.context.sessionId === lease.sessionId && input.context.turnId === lease.turnId
    && input.context.stepId === input.step.id && safeId(input.step.id) && Number.isSafeInteger(input.step.ordinal)
    && input.step.ordinal >= 0
}

async function readCurrentChildren(pool: Pick<pg.Pool, "connect">, input: PrepareFinalDependencyWaitInput,
  lease: SubagentLease): Promise<readonly NestedScoutChildRow[]> {
  let client: Client | undefined, transaction = false
  try {
    client = await pool.connect() as Client
    await client.query("BEGIN READ ONLY"); transaction = true
    await client.query("SELECT set_config('app.user_id', $1, true)", [lease.userId])
    const owner = await client.query<WaitRow>(`SELECT step."id" AS "stepId", step."ordinal" AS "stepOrdinal", step."status" AS "stepStatus",
        step."taskId" AS "stepTaskId", step."sessionId" AS "stepSessionId", step."turnId" AS "stepTurnId", step."attempt" AS "stepAttempt",
        session."id" AS "sessionId", session."userId" AS "sessionUserId", session."status" AS "sessionStatus",
        turn."id" AS "turnId", turn."sessionId" AS "turnSessionId", turn."rootTaskId" AS "turnRootTaskId",
        parent."id" AS "parentId", session."userId" AS "parentUserId", parent."sessionId" AS "parentSessionId", parent."turnId" AS "parentTurnId",
        parent."rootTaskId" AS "parentRootTaskId", parent."parentTaskId" AS "parentTaskId", parent."depth" AS "parentDepth",
        parent."path" AS "parentPath", parent."role" AS "parentRole", parent."taskType" AS "parentTaskType", parent."context" AS "parentContext",
        parent."status" AS "parentStatus", parent."leaseOwner" AS "parentLeaseOwner", parent."attemptCount" AS "parentAttemptCount",
        parent."interruptRequestedAt" AS "parentInterruptRequestedAt"
      FROM "agent_steps" step JOIN "agent_sessions" session ON session."id" = step."sessionId"
      JOIN "agent_turns" turn ON turn."id" = step."turnId" AND turn."sessionId" = step."sessionId"
      JOIN "sub_agent_tasks" parent ON parent."id" = step."taskId" AND parent."sessionId" = step."sessionId" AND parent."turnId" = step."turnId"
      WHERE step."id" = $1 AND step."ordinal" = $2 AND step."status" = 'streaming' AND step."taskId" = $3
        AND step."sessionId" = $4 AND step."turnId" = $5 AND step."attempt" = $6
        AND session."userId" = $7 AND session."status" NOT IN ('aborted', 'archived')
        AND turn."rootTaskId" = $8 AND parent."rootTaskId" = $8 AND parent."parentTaskId" = $8
        AND parent."depth" = 1 AND parent."role" = 'scout' AND parent."taskType" = 'job_discovery'
        AND parent."status" = 'running' AND parent."leaseOwner" = $9 AND parent."attemptCount" = $6
        AND parent."interruptRequestedAt" IS NULL AND parent."leaseExpiresAt" > clock_timestamp()`,
    [input.step.id, input.step.ordinal, lease.id, lease.sessionId, lease.turnId, lease.attemptCount, lease.userId, lease.rootTaskId, lease.ownerId])
    const row = owner.rows[0]
    if (!row || !validOwnerRow(row, input, lease)) throw new Error("nested_scout_final_wait_owner_unavailable")
    const result = await client.query<WaitRow>(`SELECT child."id" AS "taskId", childSession."userId" AS "userId", child."sessionId", child."turnId",
        child."rootTaskId", child."parentTaskId", child."depth", child."path", child."status", child."role", child."taskType", child."context",
        parent."path" AS "parentPath"
      FROM "sub_agent_tasks" child JOIN "sub_agent_tasks" parent ON parent."id" = child."parentTaskId"
      JOIN "agent_sessions" childSession ON childSession."id" = child."sessionId"
      WHERE child."parentTaskId" = $1 AND childSession."userId" = $2 AND child."sessionId" = $3
        AND child."turnId" = $4 AND child."rootTaskId" = $5 AND child."depth" = 2
        AND parent."sessionId" = $3 AND parent."turnId" = $4 AND parent."rootTaskId" = $5 AND parent."depth" = 1
      ORDER BY child."createdAt", child."id" LIMIT 3`, [lease.id, lease.userId, lease.sessionId, lease.turnId, lease.rootTaskId])
    if (result.rows.length > 2) throw new Error("nested_scout_final_wait_children_invalid")
    const children = result.rows.map(child => readChildRow(child, lease))
    await client.query("COMMIT"); transaction = false
    return children
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "nested_scout_final_wait_owner_unavailable") throw error
    throw new Error("nested_scout_final_wait_unavailable")
  } finally {
    if (transaction) await client?.query("ROLLBACK").catch(() => undefined)
    try { client?.release() } catch { /* keep the original fail-closed result */ }
  }
}

function validOwnerRow(row: WaitRow, input: PrepareFinalDependencyWaitInput, lease: SubagentLease): boolean {
  const parent = { role: row.parentRole, taskType: row.parentTaskType, depth: readInteger(row.parentDepth),
    parentTaskId: row.parentTaskId, rootTaskId: row.parentRootTaskId, context: row.parentContext }
  return row.stepId === input.step.id && readInteger(row.stepOrdinal) === input.step.ordinal && row.stepStatus === "streaming"
    && row.stepTaskId === lease.id && row.stepSessionId === lease.sessionId && row.stepTurnId === lease.turnId
    && readInteger(row.stepAttempt) === lease.attemptCount && row.sessionId === lease.sessionId && row.sessionUserId === lease.userId
    && row.sessionStatus !== "aborted" && row.sessionStatus !== "archived" && row.turnId === lease.turnId
    && row.turnSessionId === lease.sessionId && row.turnRootTaskId === lease.rootTaskId
    && row.parentId === lease.id && row.parentUserId === lease.userId && row.parentSessionId === lease.sessionId
    && row.parentTurnId === lease.turnId && row.parentRootTaskId === lease.rootTaskId && row.parentTaskId === lease.rootTaskId
    && readInteger(row.parentDepth) === 1 && row.parentPath === `/${lease.rootTaskId}/${lease.id}`
    && row.parentRole === "scout" && row.parentTaskType === "job_discovery" && row.parentStatus === "running"
    && row.parentLeaseOwner === lease.ownerId && readInteger(row.parentAttemptCount) === lease.attemptCount
    && row.parentInterruptRequestedAt === null && nestedScoutProfileForTask(parent) !== null
}

function readChildRow(row: WaitRow, lease: SubagentLease): NestedScoutChildRow {
  const taskId = requiredText(row.taskId), parentPath = requiredText(row.parentPath)
  if (row.userId !== lease.userId || row.sessionId !== lease.sessionId || row.turnId !== lease.turnId
    || row.rootTaskId !== lease.rootTaskId || row.parentTaskId !== lease.id || readInteger(row.depth) !== 2
    || row.path !== `${parentPath}/${taskId}` || parentPath !== `/${lease.rootTaskId}/${lease.id}`) {
    throw new Error("nested_scout_final_wait_children_invalid")
  }
  return { taskId, status: requiredText(row.status), role: requiredText(row.role), taskType: requiredText(row.taskType), context: row.context,
    result: null, failureReason: null }
}

function hasDeliveredWaitOutcome(input: PrepareFinalDependencyWaitInput, taskIds: readonly string[]): boolean {
  const observations = Array.isArray(input.snapshot.toolObservations) ? input.snapshot.toolObservations : []
  if (observations.length > 2_048 || input.context.blocks.length > 4_096) return false
  const matches = observations.flatMap(block => {
    const item = safeRecord(block), content = safeRecord(item?.content), waitInput = safeRecord(content?.input)
    if (!item || typeof item.id !== "string" || !item.id.startsWith("child-resume:")
      || content?.toolName !== "wait_subagents" || !waitInput || !sameIds(waitInput.taskIds, taskIds)) return []
    return [{ id: item.id, content }]
  })
  if (matches.length === 0) return false
  const latest = matches[matches.length - 1]!
  const expected = waitProjection(latest.id, latest.content, taskIds)
  if (!expected) return false
  const visible = input.context.blocks.filter((block: ContextBlock) => block.layer === "tool_observation" && block.role === "data"
    && block.trust === "external_untrusted" && block.source === "tool-or-subagent" && block.id === expected.id)
  if (visible.length !== 1) return false
  const content = safeRecord(visible[0]!.content), projection = content && waitProjection(expected.id, content, taskIds)
  return !!projection && JSON.stringify(projection.signature) === JSON.stringify(expected.signature)
}

function waitProjection(id: string, content: Record<string, unknown>, taskIds: readonly string[]): { id: string; signature: readonly unknown[] } | null {
  if (!exactKeys(content, ["toolCallId", "toolName", "input", "status", "output", "errorCode"]) || content.toolName !== "wait_subagents"
    || content.status !== "completed" || content.errorCode !== null || !safeId(content.toolCallId)) return null
  const input = safeRecord(content.input), output = safeRecord(content.output)
  if (!input || !exactKeys(input, ["idempotencyKey", "taskIds", "mode", "timeoutMs"]) || !safeId(input.idempotencyKey)
    || input.mode !== "all" || !Number.isSafeInteger(input.timeoutMs) || Number(input.timeoutMs) < 1 || Number(input.timeoutMs) > 30_000
    || !sameIds(input.taskIds, taskIds) || !output || !exactKeys(output, ["waitId", "status", "taskIds", "deadlineAt", "matchedTaskIds", "tasks"])
    || !safeId(output.waitId) || !(output.status === "ready" || output.status === "timed_out")
    || typeof output.deadlineAt !== "string" || !Number.isFinite(Date.parse(output.deadlineAt)) || !sameIds(output.taskIds, taskIds)) return null
  const matched = strictIds(output.matchedTaskIds)
  const tasks = denseRecords(output.tasks)
  if (!matched || matched.some(id => !taskIds.includes(id)) || !tasks || tasks.length !== taskIds.length) return null
  const projectedTasks = tasks.map(task => {
    if (!exactKeys(task, ["taskId", "status", "role", "result", "failureReason"]) || !safeId(task.taskId)
      || !KNOWN.has(String(task.status)) || task.role !== "scout" || !(task.failureReason === null || typeof task.failureReason === "string")) return null
    return [task.taskId, task.status, task.role] as const
  })
  if (projectedTasks.some(task => task === null) || !sameIds(projectedTasks.map(task => task![0]), taskIds)) return null
  const terminalIds = projectedTasks.flatMap(task => TERMINAL.has(String(task![1])) ? [task![0]] : [])
  if (!sameIds(terminalIds, matched) || !sameIds(terminalIds, taskIds)
    || output.status === "ready" && !sameIds(matched, taskIds)) return null
  return { id, signature: [content.toolCallId, input.idempotencyKey, taskIds, input.timeoutMs, output.waitId, output.status,
    output.deadlineAt, matched, projectedTasks] }
}

function safeRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) return null
      record[key] = descriptor.value
    }
    return record
  } catch { return null }
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort(), keys = [...expected].sort()
  return actual.length === keys.length && actual.every((key, index) => key === keys[index])
}
function safeId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) }
function requiredText(value: unknown): string { if (typeof value !== "string" || !value) throw new Error("nested_scout_final_wait_children_invalid"); return value }
function readInteger(value: unknown): number { const parsed = typeof value === "number" ? value : Number(value); return Number.isSafeInteger(parsed) ? parsed : -1 }
function strictIds(value: unknown): string[] | null { return Array.isArray(value) && value.length <= 2 && value.every(safeId) && new Set(value).size === value.length ? value as string[] : null }
function sameIds(value: unknown, expected: readonly string[]): value is readonly string[] {
  const ids = strictIds(value)
  return !!ids && ids.length === expected.length && expected.every(id => ids.includes(id))
}
function denseRecords(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value) || value.length > 2 || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) return null
  const records: Record<string, unknown>[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index)), record = descriptor && "value" in descriptor ? safeRecord(descriptor.value) : null
    if (!descriptor?.enumerable || !record) return null
    records.push(record)
  }
  return records
}
