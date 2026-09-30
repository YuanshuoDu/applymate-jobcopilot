import { CoordinationError, type CoordinationTaskView } from "./coordination-types.js"
import type { ToolExecutionContext } from "./types.js"
import type { CoordinationExecutorOptions } from "./coordination-executors.js"

export async function visibleTask(context: ToolExecutionContext, taskId: string, options: CoordinationExecutorOptions): Promise<CoordinationTaskView> {
  const task = await options.store.getTask({ userId: context.scope.userId, sessionId: context.sessionId, taskId })
  if (!task) throw new CoordinationError("coordination_task_not_found", "Subagent task is unavailable")
  if (context.rootTaskId && task.rootTaskId !== context.rootTaskId) throw new CoordinationError("coordination_task_not_found", "Subagent task is unavailable")
  if (context.taskId) {
    const current = await options.store.getTask({ userId: context.scope.userId, sessionId: context.sessionId, taskId: context.taskId })
    if (!current || current.rootTaskId !== task.rootTaskId) throw new CoordinationError("coordination_task_not_found", "Subagent task is unavailable")
  }
  return task
}

export async function lifecycleTarget(context: ToolExecutionContext, taskId: string, options: CoordinationExecutorOptions): Promise<CoordinationTaskView> {
  const target = await visibleTask(context, taskId, options)
  if (!context.taskId) return target
  const caller = await visibleTask(context, context.taskId, options)
  const isRootCaller = caller.id === caller.rootTaskId
  const isSelfOrDescendant = target.id === caller.id || isTaskPathWithin(target.path, caller.path)
  if (isRootCaller || isSelfOrDescendant) return target
  throw new CoordinationError("coordination_task_not_found", "Subagent task is unavailable")
}

function isTaskPathWithin(path: string, ancestorPath: string): boolean { return path.startsWith(`${ancestorPath}/`) }
