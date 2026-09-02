import { assertInterruptTarget, interruptTargetKey, type ExternalActionEvidence, type ExternalActionEvidenceResolver, type ExternalActionRecord, type ExternalActionResolution, type InterruptTarget } from "./types.js"
import type { AbortOperationHandle, RootAbortController } from "./registry.js"

export type ExternalActionHandle = {
  readonly actionId: string
  readonly signal: AbortSignal
  complete(now?: Date): ExternalActionRecord
  uncertain(now?: Date): ExternalActionRecord
}

type TrackedAction = ExternalActionEvidence & {
  abort: AbortOperationHandle
  resolution: ExternalActionResolution | null
  resolvedAt: Date | null
}

function actionKey(target: InterruptTarget, actionId: string): string {
  return `${interruptTargetKey(target)}:${actionId}`
}

function validateAction(action: ExternalActionEvidence): void {
  assertInterruptTarget(action)
  if (action.actionId.trim().length === 0) throw new TypeError("External actionId must be a non-empty string")
  if (action.operation.trim().length === 0) throw new TypeError("External operation must be a non-empty string")
  if (Number.isNaN(action.startedAt.getTime())) throw new TypeError("External action startedAt must be a valid Date")
}

/** Tracks non-repeatable work separately from ordinary cancelable tools. */
export class ExternalActionRegistry {
  private readonly actions = new Map<string, TrackedAction>()

  begin(root: RootAbortController, action: ExternalActionEvidence): ExternalActionHandle {
    validateAction(action)
    const key = actionKey(action, action.actionId)
    if (this.actions.has(key)) throw new Error(`External action is already tracked: ${action.actionId}`)
    const operation = root.register("tool", `external:${action.actionId}`)
    const tracked: TrackedAction = { ...action, abort: operation, resolution: null, resolvedAt: null }
    this.actions.set(key, tracked)
    return {
      actionId: action.actionId,
      signal: operation.signal,
      complete: (now) => this.resolve(tracked, "completed", now),
      uncertain: (now) => this.resolve(tracked, "uncertain", now),
    }
  }

  async reconcile(
    target: InterruptTarget,
    resolver?: ExternalActionEvidenceResolver,
    now = new Date(),
  ): Promise<ExternalActionRecord[]> {
    assertInterruptTarget(target)
    const pending = [...this.actions.values()].filter((action) =>
      action.userId === target.userId && action.sessionId === target.sessionId && action.turnId === target.turnId && !action.resolution,
    )
    const resolved: ExternalActionRecord[] = []
    for (const action of pending) {
      let outcome: ExternalActionResolution = "uncertain"
      if (resolver) {
        try {
          outcome = await resolver.reconcile(action)
        } catch {
          outcome = "uncertain"
        }
      }
      resolved.push(this.resolve(action, outcome, now))
    }
    return resolved
  }

  records(target: InterruptTarget): readonly ExternalActionRecord[] {
    assertInterruptTarget(target)
    return [...this.actions.values()]
      .filter((action) => action.userId === target.userId && action.sessionId === target.sessionId && action.turnId === target.turnId && action.resolution)
      .map((action) => this.record(action))
  }

  get activeCount(): number {
    return [...this.actions.values()].filter((action) => !action.resolution).length
  }

  private resolve(action: TrackedAction, resolution: ExternalActionResolution, now = new Date()): ExternalActionRecord {
    if (action.resolution) return this.record(action)
    action.resolution = resolution
    action.resolvedAt = now
    action.abort.close()
    return this.record(action)
  }

  private record(action: TrackedAction): ExternalActionRecord {
    if (!action.resolution || !action.resolvedAt) throw new Error("External action has not been reconciled")
    return {
      userId: action.userId,
      sessionId: action.sessionId,
      turnId: action.turnId,
      actionId: action.actionId,
      operation: action.operation,
      startedAt: action.startedAt,
      resolution: action.resolution,
      resolvedAt: action.resolvedAt,
    }
  }
}
