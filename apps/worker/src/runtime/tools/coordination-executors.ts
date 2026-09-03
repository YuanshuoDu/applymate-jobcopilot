import { CoordinationError, type CoordinationRuntimeOptions, type CoordinationTaskView } from "./coordination-types.js"
import type { ToolExecutionContext } from "./types.js"
import type {
  CloseSubagentInput,
  InterruptSubagentInput,
  ListSubagentsInput,
  SendMessageInput,
  SpawnSubagentInput,
  WaitSubagentsInput,
} from "./coordination-tools.js"

export type CoordinationExecutorOptions = CoordinationRuntimeOptions

export async function executeSpawn(context: ToolExecutionContext, input: SpawnSubagentInput, options: CoordinationExecutorOptions) {
  const parentTaskId = await resolveSpawnParent(context, input.parentTaskId, options)
  const replay = await options.store.getSpawnReplay({ userId: context.scope.userId, sessionId: context.sessionId, idempotencyKey: input.idempotencyKey })
  if (replay) {
    await activity(context, options, "spawn_subagent", replay.id, { path: replay.path, status: replay.status, replay: true }, input.idempotencyKey)
    return spawnOutput(replay, true)
  }
  let task: CoordinationTaskView
  try {
    task = await options.manager.spawn({
      userId: context.scope.userId, sessionId: context.sessionId, turnId: context.turnId, parentTaskId,
      role: input.role, taskType: input.taskType, goal: input.goal, constraints: input.constraints,
      successCriteria: input.successCriteria, allowedActions: input.allowedActions, context: input.context,
      expectedOutputSchema: input.expectedOutputSchema,
    })
  } catch (error: unknown) { throw managerError(error) }
  try {
    const recorded = await options.store.recordSpawn({ userId: context.scope.userId, sessionId: context.sessionId, idempotencyKey: input.idempotencyKey, task })
    if (!recorded) {
      const winner = await options.store.getSpawnReplay({ userId: context.scope.userId, sessionId: context.sessionId, idempotencyKey: input.idempotencyKey })
      await options.manager.close(task.id, context.sessionId)
      if (winner) return spawnOutput(winner, true)
      throw new CoordinationError("coordination_idempotency_conflict", "Spawn idempotency record was lost")
    }
  } catch (error: unknown) {
    await options.manager.close(task.id, context.sessionId).catch(() => false)
    throw error
  }
  await activity(context, options, "spawn_subagent", task.id, { path: task.path, status: task.status }, input.idempotencyKey)
  return spawnOutput(task, false)
}

export async function executeSendMessage(context: ToolExecutionContext, input: SendMessageInput, options: CoordinationExecutorOptions) {
  const target = await visibleTask(context, input.taskId, options)
  const sender = context.taskId ? await visibleTask(context, context.taskId, options) : null
  const result = await options.store.sendMessage({
    userId: context.scope.userId, sessionId: context.sessionId, turnId: context.turnId,
    fromTaskId: sender?.id ?? null, toTaskId: target.id, kind: input.kind, payload: input.payload, idempotencyKey: input.idempotencyKey,
  })
  await activity(context, options, "send_message", target.id, { kind: input.kind, duplicate: result.duplicate }, input.idempotencyKey)
  return { messageId: result.message.id, taskId: target.id, status: result.duplicate ? "duplicate" as const : "queued" as const }
}

export async function executeWaitSubagents(context: ToolExecutionContext, input: WaitSubagentsInput, options: CoordinationExecutorOptions) {
  if (!options.wait) throw new CoordinationError("coordination_wait_unavailable", "Durable wait integration from AH2-025 is not available")
  const current = context.taskId ? await visibleTask(context, context.taskId, options) : null
  const targets = await uniqueTasks(context, input.taskIds, options)
  const result = await options.wait.wait({
    userId: context.scope.userId, sessionId: context.sessionId, turnId: context.turnId, stepId: context.stepId,
    taskId: current?.id ?? null, rootTaskId: current?.rootTaskId ?? context.rootTaskId ?? null,
    targetTaskIds: targets.map(task => task.id), mode: input.mode, timeoutMs: input.timeoutMs, idempotencyKey: input.idempotencyKey,
  })
  await activity(context, options, "wait_subagents", current?.id ?? null, { status: result.status, targetCount: targets.length }, input.idempotencyKey)
  return { waitId: result.waitId, status: result.status, taskIds: targets.map(task => task.id), deadlineAt: result.deadlineAt, matchedTaskIds: [...result.matchedTaskIds] }
}

export async function executeListSubagents(context: ToolExecutionContext, input: ListSubagentsInput, options: CoordinationExecutorOptions) {
  const current = context.taskId ? await visibleTask(context, context.taskId, options) : null
  const rootTaskId = current?.rootTaskId ?? context.rootTaskId
  const tasks = await options.store.listTasks({ userId: context.scope.userId, sessionId: context.sessionId, rootTaskId, includeTerminal: input.includeTerminal ?? false })
  await activity(context, options, "list_subagents", current?.id ?? null, { count: tasks.length })
  return { tasks: tasks.filter(task => task.id !== current?.id).map(taskOutput) }
}

export async function executeInterruptSubagent(context: ToolExecutionContext, input: InterruptSubagentInput, options: CoordinationExecutorOptions) {
  const target = await visibleTask(context, input.taskId, options)
  let affected: number
  try { affected = await options.manager.interrupt(context.sessionId, target.rootTaskId) } catch (error: unknown) { throw managerError(error) }
  await options.wait?.cancel?.({ userId: context.scope.userId, sessionId: context.sessionId, taskId: target.rootTaskId, reason: "interrupted" })
  await activity(context, options, "interrupt_subagent", target.id, { rootTaskId: target.rootTaskId, affected }, target.id)
  return { taskId: target.id, rootTaskId: target.rootTaskId, status: "interrupt_requested" as const, affectedCount: affected, reason: input.reason ?? null }
}

export async function executeCloseSubagent(context: ToolExecutionContext, input: CloseSubagentInput, options: CoordinationExecutorOptions) {
  const target = await visibleTask(context, input.taskId, options)
  if (["running"].includes(target.status)) throw new CoordinationError("coordination_close_not_allowed", "Running subagents must be interrupted before close")
  if (["completed", "failed", "interrupted", "cancelled", "closed"].includes(target.status)) {
    await activity(context, options, "close_subagent", target.id, { status: target.status, closed: false }, target.id)
    return { taskId: target.id, status: target.status as "completed" | "failed" | "interrupted" | "cancelled" | "closed", closed: false }
  }
  const closed = await options.manager.close(target.id, context.sessionId)
  if (!closed) throw new CoordinationError("coordination_close_conflict", "Subagent close was fenced by another owner")
  await options.wait?.cancel?.({ userId: context.scope.userId, sessionId: context.sessionId, taskId: target.id, reason: "closed" })
  await activity(context, options, "close_subagent", target.id, { status: "closed" }, target.id)
  return { taskId: target.id, status: "closed" as const, closed: true }
}

async function visibleTask(context: ToolExecutionContext, taskId: string, options: CoordinationExecutorOptions): Promise<CoordinationTaskView> {
  const task = await options.store.getTask({ userId: context.scope.userId, sessionId: context.sessionId, taskId })
  if (!task) throw new CoordinationError("coordination_task_not_found", "Subagent task is unavailable")
  if (context.rootTaskId && task.rootTaskId !== context.rootTaskId) throw new CoordinationError("coordination_task_not_found", "Subagent task is unavailable")
  if (context.taskId) {
    const current = await options.store.getTask({ userId: context.scope.userId, sessionId: context.sessionId, taskId: context.taskId })
    if (!current || current.rootTaskId !== task.rootTaskId) throw new CoordinationError("coordination_task_not_found", "Subagent task is unavailable")
  }
  return task
}

async function resolveSpawnParent(context: ToolExecutionContext, requested: string | undefined, options: CoordinationExecutorOptions): Promise<string | null> {
  if (requested && (!context.taskId || requested !== context.taskId)) throw new CoordinationError("coordination_scope_error", "Spawn parent must be the runtime-owned current task")
  if (!requested) return context.taskId ?? null
  await visibleTask(context, requested, options)
  return requested
}

async function uniqueTasks(context: ToolExecutionContext, ids: readonly string[], options: CoordinationExecutorOptions): Promise<CoordinationTaskView[]> {
  const unique = [...new Set(ids)]
  if (unique.length !== ids.length) throw new CoordinationError("coordination_invalid_input", "Wait taskIds must be unique")
  return Promise.all(unique.map(id => visibleTask(context, id, options)))
}

function spawnOutput(task: CoordinationTaskView, replay: boolean) { return { taskId: task.id, rootTaskId: task.rootTaskId, parentTaskId: task.parentTaskId, path: task.path, depth: task.depth, status: task.status, replay } }
function taskOutput(task: CoordinationTaskView) { return { taskId: task.id, rootTaskId: task.rootTaskId, parentTaskId: task.parentTaskId, path: task.path, depth: task.depth, role: task.role, taskType: task.taskType, status: task.status, attemptCount: task.attemptCount, maxAttempts: task.maxAttempts, leaseExpiresAt: task.leaseExpiresAt?.toISOString() ?? null, interruptRequestedAt: task.interruptRequestedAt?.toISOString() ?? null } }
function managerError(error: unknown): CoordinationError { const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "manager_failed"; return new CoordinationError(`coordination_${code}`, error instanceof Error ? error.message : "Subagent manager operation failed") }
async function activity(context: ToolExecutionContext, options: CoordinationExecutorOptions, operation: string, taskId: string | null, data: Record<string, unknown>, operationKey?: string): Promise<void> {
  const key = `${operationKey ?? context.toolCallId ?? `${context.sessionId}:${context.turnId}:${context.stepId}`}:${operation}`
  await options.store.appendActivity({ userId: context.scope.userId, sessionId: context.sessionId, turnId: context.turnId, stepId: context.stepId, taskId, operation, status: "completed", idempotencyKey: key, data })
  await context.reportProgress({ type: "subagent_activity", operation, taskId, status: "completed", data }).catch(() => undefined)
}
