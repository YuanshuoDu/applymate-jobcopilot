import type { AgentTreeManager } from "./manager.js"
import type { CoordinationStore, DurableWaitPort } from "../tools/coordination-types.js"

export type RootLifecycleContext = {
  readonly userId: string
  readonly sessionId: string
  readonly turnId: string
  readonly stepId: string
  readonly rootTaskId: string
}

export type RootLifecycleInput = {
  readonly idempotencyKey: string
  readonly taskIds?: readonly string[]
  readonly targetTaskId?: string
  readonly timeoutMs?: number
  readonly mode?: "any" | "all"
  readonly kind?: string
  readonly payload?: unknown
}

export class RootLifecycleError extends Error {
  constructor(readonly code: "wait_unavailable" | "task_not_visible" | "close_running", message: string) {
    super(message)
    this.name = "RootLifecycleError"
  }
}

export class RootTaskLifecycle {
  constructor(
    private readonly manager: AgentTreeManager,
    private readonly store: CoordinationStore,
    private readonly waitPort?: DurableWaitPort,
  ) {}

  async wait(context: RootLifecycleContext, input: RootLifecycleInput) {
    if (!this.waitPort) throw new RootLifecycleError("wait_unavailable", "Durable root wait is unavailable")
    const taskIds = [...new Set(input.taskIds ?? [])]
    if (taskIds.length === 0) throw new RootLifecycleError("task_not_visible", "Root wait requires at least one task")
    await Promise.all(taskIds.map(taskId => this.visible(context, taskId)))
    return this.waitPort.wait({
      userId: context.userId, sessionId: context.sessionId, turnId: context.turnId, stepId: context.stepId,
      taskId: context.rootTaskId, rootTaskId: context.rootTaskId, targetTaskIds: taskIds,
      mode: input.mode ?? "all", timeoutMs: input.timeoutMs ?? 30_000, idempotencyKey: input.idempotencyKey,
    })
  }

  async message(context: RootLifecycleContext, input: RootLifecycleInput) {
    if (!input.targetTaskId || !input.kind || input.payload === undefined) throw new RootLifecycleError("task_not_visible", "Root message requires target, kind, and payload")
    const target = await this.visible(context, input.targetTaskId)
    return this.store.sendMessage({
      userId: context.userId, sessionId: context.sessionId, turnId: context.turnId,
      fromTaskId: context.rootTaskId, toTaskId: target.id, kind: input.kind, payload: input.payload, idempotencyKey: input.idempotencyKey,
    })
  }

  async close(context: RootLifecycleContext): Promise<boolean> {
    const root = await this.visible(context, context.rootTaskId)
    if (root.status === "running") throw new RootLifecycleError("close_running", "Running root tasks must be interrupted before close")
    return this.manager.close(root.id, context.sessionId)
  }

  private async visible(context: RootLifecycleContext, taskId: string) {
    const task = await this.store.getTask({ userId: context.userId, sessionId: context.sessionId, taskId })
    if (!task || task.rootTaskId !== context.rootTaskId) throw new RootLifecycleError("task_not_visible", "Subagent task is unavailable")
    return task
  }
}
