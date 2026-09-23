import { CoordinationError, type CoordinationRuntimeOptions, type CoordinationTaskView } from "./coordination-types.js"
import { TERMINAL_TASK_STATUSES } from "./coordination-followup.js"
import { validatedStructuredResult } from "./coordination-result-aggregate.js"
import { lifecycleTarget, visibleTask } from "./coordination-visibility.js"
import { sanitizeLifecyclePreview } from "./redaction.js"
import type { ToolExecutionContext } from "./types.js"

export type CoordinationExecutorOptions = CoordinationRuntimeOptions

const WAIT_RESULT_MAX_BYTES = 2 * 1024
const WAIT_FAILURE_MAX_BYTES = 500
const FOREIGN_RESULT_KEYS = new Set(["userId", "sessionId", "turnId", "stepId", "taskId", "parentTaskId", "rootTaskId", "ownerId", "lease", "leaseOwnerId", "leaseVersion", "idempotencyKey", "capabilities", "permissions", "allowedCapabilities", "budgetLimit", "maxBudget"])

export function currentTurnTask(context: ToolExecutionContext, task: CoordinationTaskView): CoordinationTaskView {
  if (task.turnId !== context.turnId) throw new CoordinationError("coordination_task_not_found", "Subagent task is unavailable")
  return task
}

export async function followupSource(context: ToolExecutionContext, taskId: string, options: CoordinationExecutorOptions): Promise<CoordinationTaskView> {
  const source = await lifecycleTarget(context, taskId, options)
  if (source.turnId !== context.turnId) throw new CoordinationError("coordination_task_not_found", "Subagent task is unavailable")
  if (source.id === source.rootTaskId) throw new CoordinationError("coordination_followup_root_forbidden", "A root task cannot be used as a follow-up source")
  if (!TERMINAL_TASK_STATUSES.has(source.status)) throw new CoordinationError("coordination_followup_source_not_terminal", "Follow-up source task must be terminal")
  return source
}

export async function currentFollowupParent(context: ToolExecutionContext, options: CoordinationExecutorOptions): Promise<CoordinationTaskView> {
  if (!context.taskId) throw new CoordinationError("coordination_task_not_found", "Current runtime task is unavailable")
  const current = currentTurnTask(context, await visibleTask(context, context.taskId, options))
  if (TERMINAL_TASK_STATUSES.has(current.status)) throw new CoordinationError("coordination_task_not_found", "Current runtime task is unavailable")
  return current
}

export type SpawnLineage = {
  readonly parentTaskId: string | null
  /** Undefined means the caller did not provide a branch root to compare. */
  readonly rootTaskId?: string
}

export async function resolveSpawnLineage(context: ToolExecutionContext, requested: string | undefined, options: CoordinationExecutorOptions): Promise<SpawnLineage> {
  if (requested && (!context.taskId || requested !== context.taskId)) throw new CoordinationError("coordination_scope_error", "Spawn parent must be the runtime-owned current task")
  if (!context.taskId) return { parentTaskId: null, rootTaskId: context.rootTaskId }
  const current = currentTurnTask(context, await visibleTask(context, context.taskId, options))
  return { parentTaskId: current.id, rootTaskId: current.rootTaskId }
}

export function assertSpawnReplay(replay: CoordinationTaskView, context: ToolExecutionContext, lineage: SpawnLineage): void {
  if (replay.turnId !== context.turnId || replay.parentTaskId !== lineage.parentTaskId
    || (lineage.rootTaskId !== undefined && replay.rootTaskId !== lineage.rootTaskId)) {
    throw new CoordinationError("coordination_idempotency_conflict", "Spawn replay does not match the current runtime lineage")
  }
}

export async function uniqueTasks(context: ToolExecutionContext, ids: readonly string[], options: CoordinationExecutorOptions): Promise<CoordinationTaskView[]> {
  const unique = [...new Set(ids)]
  if (unique.length !== ids.length) throw new CoordinationError("coordination_invalid_input", "Wait taskIds must be unique")
  return Promise.all(unique.map(async id => currentTurnTask(context, await visibleTask(context, id, options))))
}

export function spawnOutput(task: CoordinationTaskView, replay: boolean) {
  return { taskId: task.id, rootTaskId: task.rootTaskId, parentTaskId: task.parentTaskId, path: task.path, depth: task.depth, status: task.status, replay }
}

export function taskOutput(task: CoordinationTaskView) {
  const terminal = TERMINAL_TASK_STATUSES.has(task.status)
  return { taskId: task.id, rootTaskId: task.rootTaskId, parentTaskId: task.parentTaskId, path: task.path, depth: task.depth, role: task.role, taskType: task.taskType, status: task.status, attemptCount: task.attemptCount, maxAttempts: task.maxAttempts, leaseExpiresAt: task.leaseExpiresAt?.toISOString() ?? null, interruptRequestedAt: task.interruptRequestedAt?.toISOString() ?? null, result: terminal ? waitResult(task.result) : null, failureReason: terminal ? boundedFailureReason(task.failureReason) : null }
}

export function waitTaskOutput(task: CoordinationTaskView) {
  const checked = validatedStructuredResult(task)
  return { taskId: task.id, status: task.status, role: task.role, result: checked.invalid ? null : waitResult(task.result), failureReason: boundedFailureReason(checked.invalid ? "invalid_structured_result" : task.failureReason) }
}

export function waitResult(value: unknown): ReturnType<typeof sanitizeLifecyclePreview> | null {
  if (value === undefined || value === null) return null
  try { return stripForeignResultKeys(sanitizeLifecyclePreview(value, WAIT_RESULT_MAX_BYTES)) }
  catch { return { $truncated: true, summary: "Task result was omitted because it could not be safely encoded" } }
}

function stripForeignResultKeys(value: ReturnType<typeof sanitizeLifecyclePreview>): ReturnType<typeof sanitizeLifecyclePreview> {
  if (Array.isArray(value)) return value.map(stripForeignResultKeys)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !FOREIGN_RESULT_KEYS.has(key)).map(([key, child]) => [key, stripForeignResultKeys(child)]))
  return value
}

export function boundedFailureReason(value: string | null | undefined): string | null {
  if (value == null) return null
  let result = ""
  for (const character of value) { const next = result + character; if (Buffer.byteLength(next, "utf8") > WAIT_FAILURE_MAX_BYTES) break; result = next }
  return result
}

export function managerError(error: unknown): CoordinationError {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "manager_failed"
  return new CoordinationError(`coordination_${code}`, error instanceof Error ? error.message : "Subagent manager operation failed")
}

export async function activity(context: ToolExecutionContext, options: CoordinationExecutorOptions, operation: string, taskId: string | null, data: Record<string, unknown>, operationKey?: string): Promise<void> {
  const key = `${operationKey ?? context.toolCallId ?? `${context.sessionId}:${context.turnId}:${context.stepId}`}:${operation}`
  await options.store.appendActivity({ userId: context.scope.userId, sessionId: context.sessionId, turnId: context.turnId, stepId: context.stepId, taskId, operation, status: "completed", idempotencyKey: key, data })
  await context.reportProgress({ type: "subagent_activity", operation, taskId, status: "completed", data }).catch(() => undefined)
}
