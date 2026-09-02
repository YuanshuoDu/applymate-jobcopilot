import {
  assertInterruptTarget,
  interruptReason,
  interruptTargetKey,
  type InterruptOperationKind,
  type InterruptTarget,
} from "./types.js"

export class InterruptRequestedError extends Error {
  readonly code = "interrupt_requested" as const

  constructor(readonly target: InterruptTarget, reason = "user_stop") {
    super(`Turn interrupted: ${interruptReason(reason)}`)
    this.name = "InterruptRequestedError"
  }
}

export function isInterruptRequestedError(error: unknown): error is InterruptRequestedError {
  return error instanceof InterruptRequestedError
}

export function signalWasInterrupted(signal: AbortSignal): boolean {
  return signal.aborted && isInterruptRequestedError(signal.reason)
}

export type AbortOperationHandle = {
  readonly kind: InterruptOperationKind
  readonly operationId: string
  readonly signal: AbortSignal
  close(): void
}

export interface InterruptGate {
  readonly signal: AbortSignal
  assertCanStart(kind: InterruptOperationKind): void
}

type Operation = {
  readonly key: string
  readonly controller: AbortController
  readonly parent?: AbortSignal
  onParentAbort?: () => void
}

export class RootAbortController implements InterruptGate {
  private readonly controller = new AbortController()
  private readonly operations = new Map<string, Operation>()
  private stopError: InterruptRequestedError | null = null

  constructor(readonly target: InterruptTarget) {
    assertInterruptTarget(target)
  }

  get signal(): AbortSignal { return this.controller.signal }
  get stopped(): boolean { return this.stopError !== null }
  get reason(): InterruptRequestedError | null { return this.stopError }
  get operationCount(): number { return this.operations.size }

  assertCanStart(kind: InterruptOperationKind): void {
    if (this.stopError) throw this.stopError
    if (!kind) throw new TypeError("Interrupt operation kind is required")
  }

  register(kind: InterruptOperationKind, operationId: string, parent?: AbortSignal): AbortOperationHandle {
    if (typeof operationId !== "string" || operationId.trim().length === 0) {
      throw new TypeError("Interrupt operationId must be a non-empty string")
    }
    this.assertCanStart(kind)
    const key = `${kind}:${operationId}`
    if (this.operations.has(key)) throw new Error(`Interrupt operation is already registered: ${key}`)
    const controller = new AbortController()
    const operation: Operation = { key, controller, parent }
    const onRootAbort = () => controller.abort(this.controller.signal.reason)
    this.controller.signal.addEventListener("abort", onRootAbort, { once: true })
    if (parent) {
      const onParentAbort = () => controller.abort(parent.reason)
      operation.onParentAbort = onParentAbort
      parent.addEventListener("abort", onParentAbort, { once: true })
      if (parent.aborted) controller.abort(parent.reason)
    }
    this.operations.set(key, operation)
    return {
      kind,
      operationId,
      signal: controller.signal,
      close: () => {
        const current = this.operations.get(key)
        if (current !== operation) return
        this.operations.delete(key)
        this.controller.signal.removeEventListener("abort", onRootAbort)
        if (operation.parent && operation.onParentAbort) operation.parent.removeEventListener("abort", operation.onParentAbort)
      },
    }
  }

  stop(reason = "user_stop"): { accepted: boolean; operationCount: number } {
    if (this.stopError) return { accepted: false, operationCount: this.operations.size }
    const error = new InterruptRequestedError(this.target, reason)
    this.stopError = error
    this.controller.abort(error)
    for (const operation of this.operations.values()) operation.controller.abort(error)
    return { accepted: true, operationCount: this.operations.size }
  }
}

export class RootAbortControllerRegistry {
  private readonly roots = new Map<string, RootAbortController>()

  getOrCreate(target: InterruptTarget): RootAbortController {
    assertInterruptTarget(target)
    const key = interruptTargetKey(target)
    const existing = this.roots.get(key)
    if (existing) return existing
    const root = new RootAbortController(target)
    this.roots.set(key, root)
    return root
  }

  get(target: InterruptTarget): RootAbortController | undefined {
    return this.roots.get(interruptTargetKey(target))
  }

  stop(target: InterruptTarget, reason = "user_stop"): { accepted: boolean; operationCount: number } {
    return this.getOrCreate(target).stop(reason)
  }

  release(target: InterruptTarget): void {
    this.roots.delete(interruptTargetKey(target))
  }

  values(): readonly RootAbortController[] { return [...this.roots.values()] }
  get size(): number { return this.roots.size }
}
