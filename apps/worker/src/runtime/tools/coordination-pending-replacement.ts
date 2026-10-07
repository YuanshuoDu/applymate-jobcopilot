import { CoordinationError, type CoordinationTaskView } from "./coordination-types.js"
import { assertFollowupReplay, followupContext, followupOutput, followupProvenance } from "./coordination-followup.js"
import { appendNativeCoordination, nativeCoordinationKey, nativeCoordinationOutput, plannerEnabledRoot } from "./task-graph-coordination-bridge.js"
import { activity, currentFollowupParent, followupSource, managerError, waitResult, type CoordinationExecutorOptions } from "./coordination-executor-support.js"
import type { FollowupInput } from "./coordination-tools.js"
import type { ToolExecutionContext } from "./types.js"

function managerKey(value: string | undefined): string {
  if (!value) throw new CoordinationError("coordination_idempotency_key_required", "Coordination idempotency key is required")
  return value
}

function replacementRoot(context: ToolExecutionContext, options: CoordinationExecutorOptions): boolean {
  return plannerEnabledRoot(context, options.nativeCoordination?.enabled === true)
    && context.taskId === context.rootTaskId && typeof context.taskId === "string" && !!context.taskId.trim()
}

export async function executeFollowup(context: ToolExecutionContext, input: FollowupInput, options: CoordinationExecutorOptions) {
  if ("mode" in input) {
    if (!replacementRoot(context, options) || !options.nativeCoordination?.commandPort?.appendNativeCoordination) {
      throw new CoordinationError("coordination_native_replacement_unavailable", "Pending native task replacement is unavailable")
    }
    const idempotencyKey = nativeCoordinationKey(context, "followup", input.idempotencyKey)
    const request = {
      kind: "followup" as const, idempotencyKey, sourceTaskId: input.taskId, goal: input.goal,
      ...(input.context === undefined ? {} : { context: input.context }),
      mode: input.mode, expectedRevision: input.expectedRevision,
    }
    const result = await appendNativeCoordination({ context, options: options.nativeCoordination, request })
    if (result.receipt.source && result.receipt.source.taskId !== input.taskId) throw new CoordinationError("coordination_idempotency_conflict", "Follow-up receipt belongs to a different source task")
    await activity(context, options, "agent.followup", result.receipt.child.taskId, { path: result.receipt.child.path, status: result.receipt.child.status, sourceTaskId: input.taskId, native: true }, idempotencyKey)
    return { ...nativeCoordinationOutput("followup", result.rootTaskId, result.receipt), sourceTaskId: input.taskId }
  }
  if (plannerEnabledRoot(context, options.nativeCoordination?.enabled === true)) {
    const idempotencyKey = nativeCoordinationKey(context, "followup", input.idempotencyKey)
    const request = {
      kind: "followup" as const, idempotencyKey, sourceTaskId: input.taskId, goal: input.goal,
      ...(input.constraints === undefined ? {} : { constraints: [...input.constraints] }),
      ...(input.successCriteria === undefined ? {} : { successCriteria: [...input.successCriteria] }),
      ...(input.context === undefined ? {} : { context: input.context }),
    }
    const result = await appendNativeCoordination({ context, options: options.nativeCoordination!, request })
    if (result.receipt.source && result.receipt.source.taskId !== input.taskId) throw new CoordinationError("coordination_idempotency_conflict", "Follow-up receipt belongs to a different source task")
    await activity(context, options, "agent.followup", result.receipt.child.taskId, { path: result.receipt.child.path, status: result.receipt.child.status, sourceTaskId: input.taskId, native: true }, idempotencyKey)
    return { ...nativeCoordinationOutput("followup", result.rootTaskId, result.receipt), sourceTaskId: input.taskId }
  }
  const idempotencyKey = managerKey(input.idempotencyKey)
  const replay = await options.store.getSpawnReplay({ userId: context.scope.userId, sessionId: context.sessionId, idempotencyKey })
  if (replay) {
    const provenance = followupProvenance(replay.context)
    if (!provenance || provenance.sourceTaskId !== input.taskId) throw new CoordinationError("coordination_idempotency_conflict", "Follow-up idempotency key was reused for a different source task")
    const source = await followupSource(context, input.taskId, options)
    const parent = await currentFollowupParent(context, options)
    assertFollowupReplay(replay, source, parent, provenance, context.turnId)
    await activity(context, options, "agent.followup", replay.id, { path: replay.path, status: replay.status, sourceTaskId: source.id, replay: true }, idempotencyKey)
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
    try { result = await options.manager.spawnAtomic(spec, idempotencyKey) } catch (error: unknown) { throw managerError(error) }
    if (result.duplicate || !result.task) {
      const winner = await options.store.getSpawnReplay({ userId: context.scope.userId, sessionId: context.sessionId, idempotencyKey })
      if (!winner) throw new CoordinationError("coordination_idempotency_conflict", "Follow-up idempotency record was lost")
      const winnerProvenance = followupProvenance(winner.context)
      assertFollowupReplay(winner, source, parent, winnerProvenance, context.turnId)
      await activity(context, options, "agent.followup", winner.id, { path: winner.path, status: winner.status, sourceTaskId: input.taskId, replay: true }, idempotencyKey)
      return followupOutput(winner, input.taskId, true)
    }
    task = result.task
  } else {
    try { task = await options.manager.spawn(spec) } catch (error: unknown) { throw managerError(error) }
    try {
      const recorded = await options.store.recordSpawn({ userId: context.scope.userId, sessionId: context.sessionId, idempotencyKey, task })
      if (!recorded) {
        const winner = await options.store.getSpawnReplay({ userId: context.scope.userId, sessionId: context.sessionId, idempotencyKey })
        await options.manager.close(task.id, context.sessionId)
        if (!winner) throw new CoordinationError("coordination_idempotency_conflict", "Follow-up idempotency record was lost")
        const winnerProvenance = followupProvenance(winner.context)
        assertFollowupReplay(winner, source, parent, winnerProvenance, context.turnId)
        await activity(context, options, "agent.followup", winner.id, { path: winner.path, status: winner.status, sourceTaskId: input.taskId, replay: true }, idempotencyKey)
        return followupOutput(winner, input.taskId, true)
      }
    } catch (error: unknown) {
      await options.manager.close(task.id, context.sessionId).catch(() => false)
      throw error
    }
  }
  await activity(context, options, "agent.followup", task.id, { path: task.path, status: task.status, sourceTaskId: source.id }, idempotencyKey)
  return followupOutput(task, source.id, false)
}
