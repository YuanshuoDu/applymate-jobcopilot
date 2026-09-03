import { describe, expect, it } from "vitest"

import { bridgeAbortSignal, linkAbortSignals, runInterruptible } from "./bridge.js"
import { InterruptRequestedError, RootAbortController } from "./registry.js"

const target = { userId: "user-1", sessionId: "session-1", turnId: "turn-1" }

describe("interrupt signal bridges", () => {
  it("links a root operation and preserves the interrupt reason", () => {
    const root = new RootAbortController(target)
    const parent = new AbortController()
    const operation = bridgeAbortSignal(root, "browser", "browser-1", parent.signal)
    const linked = linkAbortSignals([root.signal, operation.signal])
    root.stop("user_stop")
    expect(operation.signal.aborted).toBe(true)
    expect(linked.signal.reason).toBeInstanceOf(InterruptRequestedError)
    linked.dispose()
    operation.close()
  })

  it("makes an in-flight interruptible operation reject with the typed root error", async () => {
    const root = new RootAbortController(target)
    const pending = runInterruptible(root, "wait", "wait-1", (signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    }))
    root.stop("user_stop")
    await expect(pending).rejects.toBeInstanceOf(InterruptRequestedError)
    expect(root.operationCount).toBe(0)
  })
})
