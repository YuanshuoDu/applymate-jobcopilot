import { describe, expect, it } from "vitest"

import { createObjectiveSubmissionRouteLifecycle } from "./objective-submission-route-lifecycle.js"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe("Objective submission route lifecycle", () => {
  it("signals cancellation before waiting for the exact paused route to settle", async () => {
    const lifecycle = createObjectiveSubmissionRouteLifecycle(100)
    const pending = deferred<void>()
    lifecycle.track(pending.promise)
    lifecycle.cancel()

    expect(lifecycle.signal.aborted).toBe(true)
    const settled = lifecycle.settle()
    pending.resolve()
    await expect(settled).resolves.toBe(true)
  })

  it("aborts on a bounded join timeout so a pending route cannot later proceed", async () => {
    const lifecycle = createObjectiveSubmissionRouteLifecycle(5)
    lifecycle.track(new Promise<void>(() => undefined))

    await expect(lifecycle.settle()).resolves.toBe(false)
    expect(lifecycle.signal.aborted).toBe(true)
  })
})
