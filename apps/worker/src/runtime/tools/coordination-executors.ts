import { CoordinationError, type CoordinationRuntimeOptions, type CoordinationTaskView } from "./coordination-types.js"
import {
  assertFollowupReplay,
  followupContext,
  followupOutput,
  followupProvenance,
  TERMINAL_TASK_STATUSES,
} from "./coordination-followup.js"
import { lifecycleTarget, visibleTask } from "./coordination-visibility.js"
import { sanitizeLifecyclePreview } from "./redaction.js"
import type { DelegateOutputSchemaMarker, ToolExecutionContext } from "./types.js"
import { getSubagentRolePolicy } from "../subagents/role-policy.js"
import { ROLE_RESULT_SCHEMA } from "../subagents/role-results.js"
import { buildScoutAnalystAggregate, validatedStructuredResult } from "./coordination-result-aggregate.js"
import type {
  CloseSubagentInput,
  FollowupInput,
  InterruptSubagentInput,
  ListSubagentsInput,
  SendMessageInput,
  SpawnSubagentInput,
  WaitSubagentsInput,
} from "./coordination-tools.js"
export type CoordinationExecutorOptions = CoordinationRuntimeOptions
const WAIT_RESULT_MAX_BYTES = 2 * 1024
const WAIT_FAILURE_MAX_BYTES = 500
const FOREIGN_RESULT_KEYS = new Set(["userId", "sessionId", "turnId", "stepId", "taskId", "parentTaskId", "rootTaskId", "ownerId", "lease", "leaseOwnerId", "leaseVersion", "idempotencyKey", "capabilities", "permissions", "allowedCapabilities", "budgetLimit", "maxBudget"])

function expectedOutputSchema(value: unknown, role: string): DelegateOutputSchemaMarker | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CoordinationError("coordination_invalid_input", "Invalid delegate output schema marker")
  const marker = value as Record<string, unknown>
  if (Object.keys(marker).length !== 2 || marker.schemaVersion !== ROLE_RESULT_SCHEMA || marker.role !== role || (role !== "scout" && role !== "analyst")) throw new CoordinationError("coordination_invalid_input", "Invalid delegate output schema marker")
  return { schemaVersion: ROLE_RESULT_SCHEMA, role }
}

export async function executeSpawn(context: ToolExecutionContext, input: SpawnSubagentInput, options: CoordinationExecutorOptions) {
  const policy = typeof input.role === "string" ? getSubagentRolePolicy(input.role) : null
  if (!policy || policy.actorRole !== "subagent" || policy.canManageChildren || policy.externalWritesEnabled) throw new CoordinationError("coordination_invalid_input", "Unsupported subagent role")
  const expectedSchema = expectedOutputSchema(context.delegateOutputSchemaMarker, input.role)
  const lineage = await resolveSpawnLineage(context, input.parentTaskId, options)
  const parentTaskId = lineage.parentTaskId
  const replay = await options.store.getSpawnReplay({ userId: context.scope.userId, sessionId: context.sessionId, idempotencyKey: input.idempotencyKey })
  if (replay) {
    assertSpawnReplay(replay, context, lineage)
    await activity(context, options, "spawn_subagent", replay.id, { path: replay.path, status: replay.status, replay: true }, input.idempotencyKey)
    return spawnOutput(replay, true)
  }
  let task: CoordinationTaskView
  const spec = {
    userId: context.scope.userId, sessionId: context.sessionId, turnId: context.turnId, parentTaskId,
    role: input.role, taskType: input.taskType, goal: input.goal, constraints: input.constraints,
    successCriteria: input.successCriteria, allowedActions: input.allowedActions, context: input.context,
    ...(expectedSchema === undefined ? {} : { expectedOutputSchema: expectedSchema }),
  }
  const atomic = typeof options.manager.supportsAtomicSpawn === "function" && options.manager.supportsAtomicSpawn()
  if (atomic) {
    let result: Awaited<ReturnType<typeof options.manager.spawnAtomic>>
    try {
      result = await options.manager.spawnAtomic(spec, input.idempotencyKey)
    } catch (error: unknown) { throw managerError(error) }
    if (result.duplicate || !result.task) {
      const winner = await options.store.getSpawnReplay({ userId: context.scope.userId, sessionId: context.sessionId, idempotencyKey: input.idempotencyKey })
      if (winner) {
        assertSpawnReplay(winner, context, lineage)
        await activity(context, options, "spawn_subagent", winner.id, { path: winner.path, status: winner.status, replay: true }, input.idempotencyKey)
        return spawnOutput(winner, true)
      }
      throw new CoordinationError("coordination_idempotency_conflict", "Spawn idempotency record was lost")
    }
    task = result.task
  } else {
    try {
      task = await options.manager.spawn(spec)
    } catch (error: unknown) { throw managerError(error) }
    try {
      const recorded = await options.store.recordSpawn({ userId: context.scope.userId, sessionId: context.sessionId, idempotencyKey: input.idempotencyKey, task })
      if (!recorded) {
        const winner = await options.store.getSpawnReplay({ userId: context.scope.userId, sessionId: context.sessionId, idempotencyKey: input.idempotencyKey })
        await options.manager.close(task.id, context.sessionId)
        if (winner) {
          assertSpawnReplay(winner, context, lineage)
          await activity(context, options, "spawn_subagent", winner.id, { path: winner.path, status: winner.status, replay: true }, input.idempotencyKey)
          return spawnOutput(winner, true)
        }
        throw new CoordinationError("coordination_idempotency_conflict", "Spawn idempotency record was lost")
      }
    } catch (error: unknown) {
      await options.manager.close(task.id, context.sessionId).catch(() => false)
      throw error
    }
  }
  await activity(context, options, "spawn_subagent", task.id, { path: task.path, status: task.status }, input.idempotencyKey)
  return spawnOutput(task, false)
}

export async function executeSendMessage(context: ToolExecutionContext, input: SendMessageInput, options: CoordinationExecutorOptions) {
  const target = currentTurnTask(context, await visibleTask(context, input.taskId, options))
  const sender = context.taskId ? currentTurnTask(context, await visibleTask(context, context.taskId, options)) : null
  const result = await options.store.sendMessage({
    userId: context.scope.userId, sessionId: context.sessionId, turnId: context.turnId,
    fromTaskId: sender?.id ?? null, toTaskId: target.id, kind: input.kind, payload: input.payload, idempotencyKey: input.idempotencyKey,
  })
  await activity(context, options, "send_message", target.id, { kind: input.kind, duplicate: result.duplicate }, input.idempotencyKey)
  return { messageId: result.message.id, taskId: target.id, status: result.duplicate ? "duplicate" as const : "queued" as const }
}

export async function executeFollowup(context: ToolExecutionContext, input: FollowupInput, options: CoordinationExecutorOptions) {
  const replay = await options.store.getSpawnReplay({ userId: context.scope.userId, sessionId: context.sessionId, idempotencyKey: input.idempotencyKey })
  if (replay) {
    const provenance = followupProvenance(replay.context)
    if (!provenance || provenance.sourceTaskId !== input.taskId) throw new CoordinationError("coordination_idempotency_conflict", "Follow-up idempotency key was reused for a different source task")
    const source = await followupSource(context, input.taskId, options)
    const parent = await currentFollowupParent(context, options)
    assertFollowupReplay(replay, source, parent, provenance, context.turnId)
    await activity(context, options, "agent.followup", replay.id, { path: replay.path, status: replay.status, sourceTaskId: source.id, replay: true }, input.idempotencyKey)
    return followupOutput(replay, source.id, true)
  }

  const source = await followupSource(context, input.taskId, options)
  const parent = await currentFollowupParent(context, options)
  const spec = {
    userId: context.scope.userId, sessionId: context.sessionId, turnId: context.turnId, parentTaskId: parent.id,
    role: source.role, taskType: source.taskType, goal: input.goal, constraints: input.constraints,
    successCriteria: input.successCriteria, context: followupContext(input.context, source, value => waitResult(value)),
  }
  const atomic = typeof options.manager.supportsAtomicSpawn === "function" && options.manager.supportsAtomicSpawn()
  let task: CoordinationTaskView
  if (atomic) {
    let result: Awaited<ReturnType<typeof options.manager.spawnAtomic>>
    try { result = await options.manager.spawnAtomic(spec, input.idempotencyKey) } catch (error: unknown) { throw managerError(error) }
    if (result.duplicate || !result.task) {
      const winner = await options.store.getSpawnReplay({ userId: context.scope.userId, sessionId: context.sessionId, idempotencyKey: input.idempotencyKey })
      if (!winner) throw new CoordinationError("coordination_idempotency_conflict", "Follow-up idempotency record was lost")
      const winnerProvenance = followupProvenance(winner.context)
      assertFollowupReplay(winner, source, parent, winnerProvenance, context.turnId)
      await activity(context, options, "agent.followup", winner.id, { path: winner.path, status: winner.status, sourceTaskId: input.taskId, replay: true }, input.idempotencyKey)
      return followupOutput(winner, input.taskId, true)
    }
    task = result.task
  } else {
    try { task = await options.manager.spawn(spec) } catch (error: unknown) { throw managerError(error) }
    try {
      const recorded = await options.store.recordSpawn({ userId: context.scope.userId, sessionId: context.sessionId, idempotencyKey: input.idempotencyKey, task })
      if (!recorded) {
        const winner = await options.store.getSpawnReplay({ userId: context.scope.userId, sessionId: context.sessionId, idempotencyKey: input.idempotencyKey })
        await options.manager.close(task.id, context.sessionId)
        if (!winner) throw new CoordinationError("coordination_idempotency_conflict", "Follow-up idempotency record was lost")
        const winnerProvenance = followupProvenance(winner.context)
        assertFollowupReplay(winner, source, parent, winnerProvenance, context.turnId)
        await activity(context, options, "agent.followup", winner.id, { path: winner.path, status: winner.status, sourceTaskId: input.taskId, replay: true }, input.idempotencyKey)
        return followupOutput(winner, input.taskId, true)
      }
    } catch (error: unknown) {
      await options.manager.close(task.id, context.sessionId).catch(() => false)
      throw error
    }
  }
  await activity(context, options, "agent.followup", task.id, { path: task.path, status: task.status, sourceTaskId: source.id }, input.idempotencyKey)
  return followupOutput(task, source.id, false)
}

function currentTurnTask(context: ToolExecutionContext, task: CoordinationTaskView): CoordinationTaskView {
  if (task.turnId !== context.turnId) throw new CoordinationError("coordination_task_not_found", "Subagent task is unavailable")
  return task
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
  const hydratedTargets = result.status === "waiting" ? targets : await Promise.all(targets.map(async task => currentTurnTask(context, await visibleTask(context, task.id, options))))
  await activity(context, options, "wait_subagents", current?.id ?? null, { status: result.status, targetCount: targets.length }, input.idempotencyKey)
  const tasks = hydratedTargets.map(waitTaskOutput)
  const aggregate = buildScoutAnalystAggregate(hydratedTargets)
  return { waitId: result.waitId, status: result.status, taskIds: targets.map(task => task.id), deadlineAt: result.deadlineAt, matchedTaskIds: [...result.matchedTaskIds], tasks, ...(aggregate ? { aggregate } : {}) }
}

export async function executeListSubagents(context: ToolExecutionContext, input: ListSubagentsInput, options: CoordinationExecutorOptions) {
  const current = context.taskId ? await visibleTask(context, context.taskId, options) : null
  const rootTaskId = current?.rootTaskId ?? context.rootTaskId
  const tasks = await options.store.listTasks({ userId: context.scope.userId, sessionId: context.sessionId, rootTaskId, includeTerminal: input.includeTerminal ?? false })
  await activity(context, options, "list_subagents", current?.id ?? null, { count: tasks.length })
  return { tasks: tasks.filter(task => task.id !== current?.id).slice(0, 50).map(taskOutput) }
}

export async function executeInterruptSubagent(context: ToolExecutionContext, input: InterruptSubagentInput, options: CoordinationExecutorOptions) {
  const target = await lifecycleTarget(context, input.taskId, options)
  let affected: number
  try { affected = await options.manager.interruptSubtree(context.sessionId, target.rootTaskId, target.path) } catch (error: unknown) { throw managerError(error) }
  await options.wait?.cancel?.({ userId: context.scope.userId, sessionId: context.sessionId, taskId: target.id, reason: "interrupted" })
  await activity(context, options, "interrupt_subagent", target.id, { rootTaskId: target.rootTaskId, affected }, target.id)
  return { taskId: target.id, rootTaskId: target.rootTaskId, status: "interrupt_requested" as const, affectedCount: affected, reason: input.reason ?? null }
}

export async function executeCloseSubagent(context: ToolExecutionContext, input: CloseSubagentInput, options: CoordinationExecutorOptions) {
  const target = await lifecycleTarget(context, input.taskId, options)
  if (["running"].includes(target.status)) throw new CoordinationError("coordination_close_not_allowed", "Running subagents must be interrupted before close")
  if (["completed", "failed", "interrupted", "cancelled", "closed"].includes(target.status)) {
    if (target.status === "closed") await options.wait?.cancel?.({ userId: context.scope.userId, sessionId: context.sessionId, taskId: target.id, reason: "closed" })
    await activity(context, options, "close_subagent", target.id, { status: target.status, closed: false }, target.id)
    return { taskId: target.id, status: target.status as "completed" | "failed" | "interrupted" | "cancelled" | "closed", closed: false }
  }
  const closed = await options.manager.close(target.id, context.sessionId)
  if (!closed) throw new CoordinationError("coordination_close_conflict", "Subagent close was fenced by another owner")
  await options.wait?.cancel?.({ userId: context.scope.userId, sessionId: context.sessionId, taskId: target.id, reason: "closed" })
  await activity(context, options, "close_subagent", target.id, { status: "closed" }, target.id)
  return { taskId: target.id, status: "closed" as const, closed: true }
}

async function followupSource(context: ToolExecutionContext, taskId: string, options: CoordinationExecutorOptions): Promise<CoordinationTaskView> {
  const source = await lifecycleTarget(context, taskId, options)
  if (source.turnId !== context.turnId) throw new CoordinationError("coordination_task_not_found", "Subagent task is unavailable")
  if (source.id === source.rootTaskId) throw new CoordinationError("coordination_followup_root_forbidden", "A root task cannot be used as a follow-up source")
  if (!TERMINAL_TASK_STATUSES.has(source.status)) throw new CoordinationError("coordination_followup_source_not_terminal", "Follow-up source task must be terminal")
  return source
}

async function currentFollowupParent(context: ToolExecutionContext, options: CoordinationExecutorOptions): Promise<CoordinationTaskView> {
  if (!context.taskId) throw new CoordinationError("coordination_task_not_found", "Current runtime task is unavailable")
  const current = currentTurnTask(context, await visibleTask(context, context.taskId, options))
  if (TERMINAL_TASK_STATUSES.has(current.status)) throw new CoordinationError("coordination_task_not_found", "Current runtime task is unavailable")
  return current
}

type SpawnLineage = {
  readonly parentTaskId: string | null
  /** Undefined means the caller did not provide a branch root to compare. */
  readonly rootTaskId?: string
}

async function resolveSpawnLineage(context: ToolExecutionContext, requested: string | undefined, options: CoordinationExecutorOptions): Promise<SpawnLineage> {
  if (requested && (!context.taskId || requested !== context.taskId)) throw new CoordinationError("coordination_scope_error", "Spawn parent must be the runtime-owned current task")
  if (!context.taskId) return { parentTaskId: null, rootTaskId: context.rootTaskId }
  const current = currentTurnTask(context, await visibleTask(context, context.taskId, options))
  return { parentTaskId: current.id, rootTaskId: current.rootTaskId }
}

function assertSpawnReplay(replay: CoordinationTaskView, context: ToolExecutionContext, lineage: SpawnLineage): void {
  if (replay.turnId !== context.turnId || replay.parentTaskId !== lineage.parentTaskId
    || (lineage.rootTaskId !== undefined && replay.rootTaskId !== lineage.rootTaskId)) {
    throw new CoordinationError("coordination_idempotency_conflict", "Spawn replay does not match the current runtime lineage")
  }
}

async function uniqueTasks(context: ToolExecutionContext, ids: readonly string[], options: CoordinationExecutorOptions): Promise<CoordinationTaskView[]> {
  const unique = [...new Set(ids)]
  if (unique.length !== ids.length) throw new CoordinationError("coordination_invalid_input", "Wait taskIds must be unique")
  return Promise.all(unique.map(async id => currentTurnTask(context, await visibleTask(context, id, options))))
}

function spawnOutput(task: CoordinationTaskView, replay: boolean) { return { taskId: task.id, rootTaskId: task.rootTaskId, parentTaskId: task.parentTaskId, path: task.path, depth: task.depth, status: task.status, replay } }
function taskOutput(task: CoordinationTaskView) {
  const terminal = TERMINAL_TASK_STATUSES.has(task.status)
  return { taskId: task.id, rootTaskId: task.rootTaskId, parentTaskId: task.parentTaskId, path: task.path, depth: task.depth, role: task.role, taskType: task.taskType, status: task.status, attemptCount: task.attemptCount, maxAttempts: task.maxAttempts, leaseExpiresAt: task.leaseExpiresAt?.toISOString() ?? null, interruptRequestedAt: task.interruptRequestedAt?.toISOString() ?? null, result: terminal ? waitResult(task.result) : null, failureReason: terminal ? boundedFailureReason(task.failureReason) : null }
}
function waitTaskOutput(task: CoordinationTaskView) {
  const checked = validatedStructuredResult(task)
  return { taskId: task.id, status: task.status, role: task.role, result: checked.invalid ? null : waitResult(task.result), failureReason: boundedFailureReason(checked.invalid ? "invalid_structured_result" : task.failureReason) }
}
function waitResult(value: unknown): ReturnType<typeof sanitizeLifecyclePreview> | null {
  if (value === undefined || value === null) return null
  try { return stripForeignResultKeys(sanitizeLifecyclePreview(value, WAIT_RESULT_MAX_BYTES)) }
  catch { return { $truncated: true, summary: "Task result was omitted because it could not be safely encoded" } }
}
function stripForeignResultKeys(value: ReturnType<typeof sanitizeLifecyclePreview>): ReturnType<typeof sanitizeLifecyclePreview> {
  if (Array.isArray(value)) return value.map(stripForeignResultKeys)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !FOREIGN_RESULT_KEYS.has(key)).map(([key, child]) => [key, stripForeignResultKeys(child)]))
  return value
}
function boundedFailureReason(value: string | null | undefined): string | null {
  if (value == null) return null
  let result = ""
  for (const character of value) { const next = result + character; if (Buffer.byteLength(next, "utf8") > WAIT_FAILURE_MAX_BYTES) break; result = next }
  return result
}
function managerError(error: unknown): CoordinationError { const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "manager_failed"; return new CoordinationError(`coordination_${code}`, error instanceof Error ? error.message : "Subagent manager operation failed") }
async function activity(context: ToolExecutionContext, options: CoordinationExecutorOptions, operation: string, taskId: string | null, data: Record<string, unknown>, operationKey?: string): Promise<void> {
  const key = `${operationKey ?? context.toolCallId ?? `${context.sessionId}:${context.turnId}:${context.stepId}`}:${operation}`
  await options.store.appendActivity({ userId: context.scope.userId, sessionId: context.sessionId, turnId: context.turnId, stepId: context.stepId, taskId, operation, status: "completed", idempotencyKey: key, data })
  await context.reportProgress({ type: "subagent_activity", operation, taskId, status: "completed", data }).catch(() => undefined)
}
