import {
  RootAbortController,
  type AbortOperationHandle,
} from "./registry.js"
import type { InterruptOperationKind } from "./types.js"

export type LinkedAbortSignal = {
  readonly signal: AbortSignal
  dispose(): void
}

/** Bridge a root signal into a named model/tool/task/browser/wait operation. */
export function bridgeAbortSignal(
  root: RootAbortController,
  kind: InterruptOperationKind,
  operationId: string,
  parent?: AbortSignal,
): AbortOperationHandle {
  return root.register(kind, operationId, parent)
}

/** Combine a queue/lease signal with the root interrupt signal without owning either controller. */
export function linkAbortSignals(signals: readonly AbortSignal[]): LinkedAbortSignal {
  const controller = new AbortController()
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = []
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason)
  }
  for (const signal of signals) {
    if (signal.aborted) abort(signal)
    else {
      const listener = () => abort(signal)
      signal.addEventListener("abort", listener, { once: true })
      listeners.push({ signal, listener })
    }
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const entry of listeners) entry.signal.removeEventListener("abort", entry.listener)
    },
  }
}

export async function runInterruptible<T>(
  root: RootAbortController,
  kind: InterruptOperationKind,
  operationId: string,
  work: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
): Promise<T> {
  const operation = bridgeAbortSignal(root, kind, operationId, parent)
  try {
    return await work(operation.signal)
  } finally {
    operation.close()
  }
}
