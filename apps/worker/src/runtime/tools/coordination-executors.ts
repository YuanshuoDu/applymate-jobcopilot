import { CoordinationError, type CoordinationTaskView } from "./coordination-types.js"
import { executeFollowup as runFollowup } from "./coordination-pending-replacement.js"
import { lifecycleTarget, visibleTask } from "./coordination-visibility.js"
import type { ToolExecutionContext } from "./types.js"
import { getSubagentRolePolicy } from "../subagents/role-policy.js"
import { ROLE_RESULT_SCHEMA } from "../subagents/role-results.js"
import { appendNativeCoordination, nativeCoordinationKey, nativeCoordinationOutput, plannerEnabledRoot } from "./task-graph-coordination-bridge.js"
import { buildScoutAnalystAggregate } from "./coordination-result-aggregate.js"
import {
  activity,
  assertSpawnReplay,
  currentTurnTask,
  managerError,
  resolveSpawnLineage,
  spawnOutput,
  taskOutput,
  uniqueTasks,
  waitTaskOutput,
  type CoordinationExecutorOptions,
} from "./coordination-executor-support.js"
export type { CoordinationExecutorOptions } from "./coordination-executor-support.js"
import type {
  CloseSubagentInput,
  FollowupInput,
  InterruptSubagentInput,
  ListSubagentsInput,
  SendMessageInput,
  SpawnSubagentInput,
  WaitSubagentsInput,
} from "./coordination-tools.js"
function expectedOutputSchema(value: unknown, role: string): { readonly schemaVersion: typeof ROLE_RESULT_SCHEMA; readonly role: "scout" | "analyst" } | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CoordinationError("coordination_invalid_input", "Invalid delegate output schema marker")
  const marker = value as Record<string, unknown>
  if (Object.keys(marker).length !== 2 || marker.schemaVersion !== ROLE_RESULT_SCHEMA || marker.role !== role || (role !== "scout" && role !== "analyst")) throw new CoordinationError("coordination_invalid_input", "Invalid delegate output schema marker")
  return { schemaVersion: ROLE_RESULT_SCHEMA, role: role as "scout" | "analyst" }
}
function managerKey(value: string | undefined): string {
  if (!value) throw new CoordinationError("coordination_idempotency_key_required", "Coordination idempotency key is required")
  return value
}
export async function executeSpawn(context: ToolExecutionContext, input: SpawnSubagentInput, options: CoordinationExecutorOptions) {
  const policy = typeof input.role === "string" ? getSubagentRolePolicy(input.role) : null
  if (!policy || policy.actorRole !== "subagent" || policy.canManageChildren || policy.externalWritesEnabled) throw new CoordinationError("coordination_invalid_input", "Unsupported subagent role")
  const expectedSchema = expectedOutputSchema(context.delegateOutputSchemaMarker, input.role)
  const lineage = await resolveSpawnLineage(context, input.parentTaskId, options)
  const parentTaskId = lineage.parentTaskId
  if (plannerEnabledRoot(context, options.nativeCoordination?.enabled === true)) {
    const idempotencyKey = nativeCoordinationKey(context, "spawn", input.idempotencyKey)
    const request = {
      kind: "spawn" as const, idempotencyKey, role: input.role, taskType: input.taskType, goal: input.goal,
      ...(input.constraints === undefined ? {} : { constraints: [...input.constraints] }),
      ...(input.successCriteria === undefined ? {} : { successCriteria: [...input.successCriteria] }),
      ...(input.allowedActions === undefined ? {} : { allowedActions: [...input.allowedActions] }),
      ...(input.context === undefined ? {} : { context: input.context }),
      ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
    }
    const result = await appendNativeCoordination({ context, options: options.nativeCoordination!, request, outputSchemaMarker: expectedSchema })
    await activity(context, options, "spawn_subagent", result.receipt.child.taskId, { path: result.receipt.child.path, status: result.receipt.child.status, native: true }, idempotencyKey)
    return nativeCoordinationOutput("spawn", result.rootTaskId, result.receipt)
  }
  const idempotencyKey = managerKey(input.idempotencyKey)
  const replay = await options.store.getSpawnReplay({ userId: context.scope.userId, sessionId: context.sessionId, idempotencyKey })
  if (replay) {
    assertSpawnReplay(replay, context, lineage)
    await activity(context, options, "spawn_subagent", replay.id, { path: replay.path, status: replay.status, replay: true }, idempotencyKey)
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
      result = await options.manager.spawnAtomic(spec, idempotencyKey)
    } catch (error: unknown) { throw managerError(error) }
    if (result.duplicate || !result.task) {
      const winner = await options.store.getSpawnReplay({ userId: context.scope.userId, sessionId: context.sessionId, idempotencyKey })
      if (winner) {
        assertSpawnReplay(winner, context, lineage)
        await activity(context, options, "spawn_subagent", winner.id, { path: winner.path, status: winner.status, replay: true }, idempotencyKey)
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
      const recorded = await options.store.recordSpawn({ userId: context.scope.userId, sessionId: context.sessionId, idempotencyKey, task })
      if (!recorded) {
        const winner = await options.store.getSpawnReplay({ userId: context.scope.userId, sessionId: context.sessionId, idempotencyKey })
        await options.manager.close(task.id, context.sessionId)
        if (winner) {
          assertSpawnReplay(winner, context, lineage)
          await activity(context, options, "spawn_subagent", winner.id, { path: winner.path, status: winner.status, replay: true }, idempotencyKey)
          return spawnOutput(winner, true)
        }
        throw new CoordinationError("coordination_idempotency_conflict", "Spawn idempotency record was lost")
      }
    } catch (error: unknown) {
      await options.manager.close(task.id, context.sessionId).catch(() => false)
      throw error
    }
  }
  await activity(context, options, "spawn_subagent", task.id, { path: task.path, status: task.status }, idempotencyKey)
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
export function executeFollowup(context: ToolExecutionContext, input: FollowupInput, options: CoordinationExecutorOptions) {
  return runFollowup(context, input, options)
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
