import { describe, expect, it, vi } from "vitest"

import { createPostBootstrapStartupFence } from "./post-bootstrap-startup.js"

describe("post-bootstrap startup fence", () => {
  it("closes every created resource once and preserves the first close error", async () => {
    const events: string[] = []
    const firstError = new Error("canonical close failed")
    const fence = createPostBootstrapStartupFence(() => [
      async () => { events.push("agent-run.close") },
      async () => { events.push("canonical.close"); throw firstError },
      undefined,
      async () => { events.push("wakeup.close") },
    ])

    await expect(fence.close()).rejects.toBe(firstError)
    await expect(fence.close()).rejects.toBe(firstError)

    expect(events).toEqual(["agent-run.close", "canonical.close", "wakeup.close"])
  })

  it("does not evaluate late resources after the first close begins", async () => {
    const resourceFactory = vi.fn(() => [async () => undefined])
    const fence = createPostBootstrapStartupFence(resourceFactory)

    await Promise.all([fence.close(), fence.close()])

    expect(resourceFactory).toHaveBeenCalledOnce()
  })
})
