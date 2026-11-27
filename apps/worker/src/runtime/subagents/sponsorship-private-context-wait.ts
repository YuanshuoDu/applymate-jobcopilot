import type pg from "pg"
import { canonicalJson } from "@jobcopilot/shared"
import type { TaskGraphVerificationReceipts } from "./task-graph-pg-verification-receipts.js"
import { redactDurableWaitOutput } from "../tools/durable-wait-output-redaction.js"

type Row = Record<string, unknown>
type Queryable = Pick<pg.PoolClient, "query">
type WaitTarget = Readonly<{ taskId: string; status: string; role: string }>
type Scope = Readonly<{
  userId: string; sessionId: string; turnId: string; rootTaskId: string; turnLeaseOwner: string; turnLeaseVersion: number
  rootAttemptCount: number; attempt: number; previousOrdinal: number
}>
type Projection = Readonly<{ id: string; content: unknown }>
type SelectedWait = Readonly<{ id: string; toolName: "agent.wait" | "wait_subagents"; stepId: string
  input: Row; output: Row }>

const WAIT_TOOLS = new Set(["agent.wait", "wait_subagents"])
const TASK_STATUSES = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed", "passed", "skipped"])
const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "closed", "passed", "skipped"])
const TASK_ID = /^subagent-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const WAIT_ID = /^wait-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function object(value: unknown): Row | undefined {
  if (typeof value === "string") { try { return object(JSON.parse(value) as unknown) } catch { return undefined } }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null ? value as Row : undefined } catch { return undefined }
}
function text(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
}
function exact(value: unknown, keys: readonly string[], optional: readonly string[] = []): Row | undefined {
  const parsed = object(value); if (!parsed) return undefined
  const own = Reflect.ownKeys(parsed)
  if (own.some(key => typeof key !== "string" || (!keys.includes(key) && !optional.includes(key)))
    || keys.some(key => !Object.hasOwn(parsed, key))) return undefined
  return parsed
}
function idList(value: unknown): string[] | undefined {
  let parsed = value
  if (typeof value === "string") { try { parsed = JSON.parse(value) as unknown } catch { return undefined } }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 8 || !parsed.every(id => text(id))
    || new Set(parsed).size !== parsed.length) return undefined
  return parsed as string[]
}
function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(id => right.includes(id)) && right.every(id => left.includes(id))
}
function deadline(value: unknown): number | undefined {
  const parsed = value instanceof Date ? value : typeof value === "string" ? new Date(value) : undefined
  return parsed && Number.isFinite(parsed.getTime()) ? parsed.getTime() : undefined
}
function sameJson(left: unknown, right: unknown): boolean {
  try { return canonicalJson(left) === canonicalJson(right) } catch { return false }
}
function selectedWait(receipts: TaskGraphVerificationReceipts, ordinal: number): SelectedWait | undefined {
  const calls = receipts.items.filter(item => item.type === "tool_call" && Number(item.ordinal) === ordinal
    && WAIT_TOOLS.has(String(object(item.content)?.toolName)))
  if (calls.length !== 1) return undefined
  const call = calls[0]!, content = exact(call.content, ["toolCallId", "toolName", "toolVersion", "status", "errorCode", "input"])
  const id = content?.toolCallId, toolName = content?.toolName
  const input = exact(content?.input, ["idempotencyKey", "taskIds", "mode", "timeoutMs"]), ids = idList(input?.taskIds)
  if (!content || !text(id) || !WAIT_TOOLS.has(String(toolName)) || content.toolVersion !== "1" || content.status !== "completed"
    || content.errorCode !== null || receipts.outcomes.get(id) !== "completed" || !input || !text(input.idempotencyKey)
    || (input.mode !== "all" && input.mode !== "any") || !Number.isSafeInteger(input.timeoutMs)
    || Number(input.timeoutMs) < 1 || Number(input.timeoutMs) > 30_000 || !ids
    || !text(call.stepId) || !Number.isSafeInteger(Number(call.attempt)) || Number(call.attempt) < 1) return undefined
  const results = receipts.items.filter(item => item.type === "tool_result" && Number(item.ordinal) === ordinal
    && object(item.content)?.toolCallId === id)
  if (results.length !== 1 || results[0]!.taskId !== call.taskId || results[0]!.stepId !== call.stepId
    || Number(results[0]!.attempt) !== Number(call.attempt) || Number(results[0]!.ordinal) !== Number(call.ordinal)) return undefined
  const result = exact(results[0]!.content, ["toolCallId", "output", "errorCode"])
  if (!result || result.toolCallId !== id || result.errorCode !== null) return undefined
  let output: unknown
  try { output = redactDurableWaitOutput(result.output, toolName as "agent.wait" | "wait_subagents", "turn") }
  catch { return undefined }
  const safeOutput = object(output)
  if (!safeOutput || !WAIT_ID.test(String(safeOutput.waitId)) || !text(safeOutput.deadlineAt, 64)
    || deadline(safeOutput.deadlineAt) === undefined || !idList(safeOutput.taskIds)
    || !sameIds(idList(safeOutput.taskIds)!, ids)) return undefined
  return { id, toolName: toolName as "agent.wait" | "wait_subagents", stepId: call.stepId, input: { ...input, taskIds: ids }, output: safeOutput }
}

function readyInlineTargets(wait: SelectedWait): readonly WaitTarget[] | undefined {
  const output = wait.output, inputIds = wait.input.taskIds as string[], matched = idListAllowEmpty(output.matchedTaskIds)
  const outputIds = idList(output.taskIds), tasks = Array.isArray(output.tasks) ? output.tasks.map(object) : undefined
  if (output.status !== "ready" || !outputIds || !sameIds(outputIds, inputIds) || !matched || matched.length === 0
    || matched.some(id => !inputIds.includes(id)) || wait.input.mode === "all" && !sameIds(matched, inputIds)
    || !tasks || tasks.length !== inputIds.length) return undefined
  const byId = new Map<string, Row>()
  for (const task of tasks) {
    if (!task || !text(task.taskId) || !TASK_ID.test(task.taskId) || !inputIds.includes(task.taskId) || byId.has(task.taskId)
      || !text(task.status) || !TASK_STATUSES.has(task.status) || !text(task.role)) return undefined
    byId.set(task.taskId, task)
  }
  const terminalMatched = matched.every(id => TERMINAL.has(String(byId.get(id)?.status)))
  if (byId.size !== inputIds.length || !terminalMatched || wait.input.mode === "all" && !sameIds(matched, inputIds)) return undefined
  return matched.map(taskId => ({ taskId, status: String(byId.get(taskId)!.status), role: String(byId.get(taskId)!.role) }))
}
function idListAllowEmpty(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > 8 || !value.every(id => text(id)) || new Set(value).size !== value.length) return undefined
  return value as string[]
}

function projectionMatches(projections: readonly Projection[], waitId: string, mode: string, targets: readonly string[], matched: readonly string[], tasks: readonly Row[]): boolean {
  const found = projections.filter(item => item.id === `wait-result:${waitId}`)
  if (found.length !== 1) return false
  const content = exact(found[0]!.content, ["toolCallId", "toolName", "input", "status", "output", "errorCode"])
  const input = exact(content?.input, ["taskIds", "mode"]), output = exact(content?.output,
    ["waitId", "status", "targetTaskIds", "matchedTaskIds", "tasks"])
  const projectedTargets = idList(input?.taskIds), outputTargets = idList(output?.targetTaskIds), outputMatched = idListAllowEmpty(output?.matchedTaskIds)
  const outputTasks = Array.isArray(output?.tasks) ? output.tasks.map(object) : undefined
  if (!content || content.toolCallId !== `wait:${waitId}` || content.toolName !== "agent.wait" || content.status !== "completed"
    || content.errorCode !== null || input?.mode !== mode || !projectedTargets || !sameIds(projectedTargets, targets)
    || output?.waitId !== waitId || output.status !== "ready" || !outputTargets || !sameIds(outputTargets, targets)
    || !outputMatched || !sameIds(outputMatched, matched) || !outputTasks || outputTasks.length !== tasks.length) return false
  const projectedById = new Map<string, Row>()
  for (const task of outputTasks) {
    if (!task || !text(task.taskId) || projectedById.has(task.taskId) || !text(task.status) || !text(task.role)
      || !exact(task, ["taskId", "status", "role", "result", "failureReason"], ["verificationReport", "repairReceipt"])) return false
    projectedById.set(task.taskId, task)
  }
  return projectedById.size === tasks.length && tasks.every(task => {
    const projected = projectedById.get(String(task.taskId))
    if (!projected || projected.status !== task.status || projected.role !== task.role) return false
    for (const field of ["result", "failureReason", "verificationReport", "repairReceipt"]) {
      if (Object.hasOwn(projected, field) !== Object.hasOwn(task, field)
        || Object.hasOwn(task, field) && !sameJson(projected[field], task[field])) return false
    }
    return true
  })
}

async function consumedReadyTargets(client: Queryable, scope: Scope, wait: SelectedWait, projections: readonly Projection[]): Promise<readonly WaitTarget[] | undefined> {
  const output = wait.output, inputIds = wait.input.taskIds as string[]
  const initialMatched = idListAllowEmpty(output.matchedTaskIds)
  if (output.status !== "waiting" || !initialMatched || initialMatched.some(id => !inputIds.includes(id))
    || wait.input.mode === "any" && initialMatched.length !== 0
    || wait.input.mode === "all" && initialMatched.length >= inputIds.length) return undefined
  const initialTasks = Array.isArray(output.tasks) ? output.tasks.map(object) : undefined
  if (!initialTasks || initialTasks.length !== inputIds.length || initialTasks.some(task => !task || !text(task.taskId)
    || !inputIds.includes(task.taskId) || !text(task.status) || !TASK_STATUSES.has(task.status) || !text(task.role))
    || new Set(initialTasks.map(task => task?.taskId)).size !== inputIds.length) return undefined
  // A waiting result is assembled from the task rows read before wait() checks
  // durable terminal state, so a matched task can still look nonterminal here.
  const rows = await client.query(`SELECT wait."id" AS "waitId", wait."userId", wait."sessionId", wait."turnId", wait."parentTaskId", wait."stepId",
      wait."idempotencyKey", wait."targetTaskIds", wait."mode", wait."status", wait."deadlineAt", wait."matchedTaskIds", wait."result" AS "waitResult",
      wait."suspendedAt", wait."consumedAt", step."ordinal" AS "stepOrdinal", step."attempt" AS "stepAttempt", step."status" AS "stepStatus"
    FROM "agent_wait_conditions" AS wait
    JOIN "agent_steps" AS step ON step."id" = wait."stepId" AND step."sessionId" = wait."sessionId" AND step."turnId" = wait."turnId" AND step."taskId" = wait."parentTaskId"
    JOIN "sub_agent_tasks" AS root ON root."id" = wait."parentTaskId" AND root."sessionId" = wait."sessionId" AND root."turnId" = wait."turnId"
    JOIN "agent_sessions" AS session ON session."id" = wait."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = wait."turnId" AND turn."sessionId" = wait."sessionId"
    WHERE wait."id" = $1 AND wait."userId" = $2 AND wait."sessionId" = $3 AND wait."turnId" = $4 AND wait."parentTaskId" = $5
      AND wait."idempotencyKey" = $6 AND wait."mode" = $7 AND wait."status" = 'ready'
      AND wait."suspendedAt" IS NOT NULL AND wait."consumedAt" IS NOT NULL
      AND step."ordinal" = $8 AND step."attempt" = $9 AND step."status" = 'waiting_for_tool'
      AND root."id" = $5 AND root."rootTaskId" = $5 AND root."parentTaskId" IS NULL AND root."attemptCount" = $10
      AND session."userId" = $2 AND session."status" NOT IN ('aborted', 'archived')
      AND turn."userId" = $2 AND turn."rootTaskId" = $5 AND turn."status" = 'in_progress'
      AND turn."leaseOwnerId" = $11 AND turn."leaseVersion" = $12
    FOR SHARE OF wait, step`, [output.waitId, scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId,
    wait.input.idempotencyKey, wait.input.mode, scope.previousOrdinal, scope.attempt, scope.rootAttemptCount,
    scope.turnLeaseOwner, scope.turnLeaseVersion])
  if (rows.rows.length !== 1) return undefined
  const saved = object(rows.rows[0]), rootResult = object(saved?.waitResult), request = exact(rootResult?.request, ["targetTaskIds", "mode", "timeoutMs"])
  const outcome = exact(rootResult?.outcome, ["waitId", "status", "targetTaskIds", "matchedTaskIds", "tasks"])
  const targets = idList(saved?.targetTaskIds), requestIds = idList(request?.targetTaskIds), outputTargets = idList(outcome?.targetTaskIds)
  const matched = idListAllowEmpty(saved?.matchedTaskIds), outcomeMatched = idListAllowEmpty(outcome?.matchedTaskIds)
  const tasks = Array.isArray(outcome?.tasks) ? outcome.tasks.map(value => exact(value,
    ["taskId", "status", "role", "result", "failureReason"], ["verificationReport", "repairReceipt"])) : undefined
  const outputTaskIds = tasks?.map(task => task?.taskId)
  if (!saved || saved.waitId !== output.waitId || saved.userId !== scope.userId || saved.sessionId !== scope.sessionId
    || saved.turnId !== scope.turnId || saved.parentTaskId !== scope.rootTaskId || saved.stepId !== wait.stepId
    || saved.idempotencyKey !== wait.input.idempotencyKey || saved.mode !== wait.input.mode || saved.status !== "ready"
    || saved.suspendedAt === null || saved.suspendedAt === undefined || saved.consumedAt === null || saved.consumedAt === undefined
    || Number(saved.stepOrdinal) !== scope.previousOrdinal || Number(saved.stepAttempt) !== scope.attempt || saved.stepStatus !== "waiting_for_tool"
    || deadline(saved.deadlineAt) !== deadline(output.deadlineAt) || !targets || !sameIds(targets, inputIds)
    || !request || request.mode !== wait.input.mode || typeof request.timeoutMs !== "number"
    || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs !== wait.input.timeoutMs
    || !requestIds || !sameIds(requestIds, inputIds) || !outcome || outcome.waitId !== saved.waitId || outcome.status !== "ready"
    || !outputTargets || !sameIds(outputTargets, targets) || !matched || !outcomeMatched || !sameIds(matched, outcomeMatched)
    || !sameIds(matched, idListAllowEmpty(outcomeMatched) ?? []) || matched.some(id => !targets.includes(id))
    || matched.length === 0 || wait.input.mode === "all" && !sameIds(matched, targets)
    || !tasks || tasks.length !== targets.length || !outputTaskIds || !sameIds(outputTaskIds as string[], targets)) return undefined
  const taskById = new Map<string, Row>()
  for (const task of tasks) {
    if (!task || !text(task.taskId) || taskById.has(task.taskId) || !text(task.status) || !TASK_STATUSES.has(task.status)
      || !text(task.role) || (task.failureReason !== null && typeof task.failureReason !== "string")) return undefined
    taskById.set(task.taskId, task)
  }
  const matchedAreTerminal = matched.every(id => TERMINAL.has(String(taskById.get(id)?.status ?? "")))
  if (taskById.size !== targets.length || !matchedAreTerminal || wait.input.mode === "all" && !sameIds(matched, targets)) return undefined
  const selected = matched.map(id => ({ taskId: id, status: String(taskById.get(id)!.status), role: String(taskById.get(id)!.role) }))
  if (projections.length > 0 && !projectionMatches(projections, String(saved.waitId), String(saved.mode), targets, matched, [...taskById.values()])) return undefined
  return selected
}

/** Resolves only an exact inline ready receipt or its matching consumed Root wait projection. */
export async function selectedSponsorshipWaitTargets(
  client: Queryable, receipts: TaskGraphVerificationReceipts, scope: Scope, projections: readonly Projection[] = [],
  options: Readonly<{ allowDurableConsumedResultWithoutProjection?: boolean }> = {},
): Promise<readonly WaitTarget[] | undefined> {
  const wait = selectedWait(receipts, scope.previousOrdinal)
  if (!wait || Number(wait.input.timeoutMs) < 1 || Number(wait.input.timeoutMs) > 30_000) return undefined
  const call = receipts.items.find(item => item.type === "tool_call" && Number(item.ordinal) === scope.previousOrdinal
    && object(item.content)?.toolCallId === wait.id)
  if (!call || call.taskId !== scope.rootTaskId || Number(call.attempt) !== scope.attempt
    || !text(call.stepId) || call.stepId !== wait.stepId) return undefined
  if (wait.output.status === "ready") return readyInlineTargets(wait)
  if (wait.output.status === "waiting") {
    if (!projections.length && options.allowDurableConsumedResultWithoutProjection !== true) return undefined
    return consumedReadyTargets(client, scope, wait, projections)
  }
  return undefined
}
