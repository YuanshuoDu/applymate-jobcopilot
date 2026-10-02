import { describe, expect, it, vi } from "vitest"
import { dispatchAgentDiscoveryStart } from "./agent-discovery-trigger"

function response(body: unknown, status = 200) {
  return Response.json(body, { status })
}

describe("dispatchAgentDiscoveryStart", () => {
  it("reports a disabled gate without invoking an obsolete legacy callback", async () => {
    const fetcher = vi.fn(async () => response({ mode: "unavailable", reason: "feature_disabled" }))
    const startLegacy = vi.fn()
    const onTaskGraphStarted = vi.fn()
    const options = {
      clientMessageId: "request_disabled",
      startLegacy,
      onTaskGraphStarted,
      fetcher,
    }

    await expect(dispatchAgentDiscoveryStart(options)).resolves.toEqual({ mode: "unavailable", reason: "feature_disabled" })

    expect(fetcher).toHaveBeenCalledWith("/api/agent/discovery/start", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "request_disabled" },
      body: JSON.stringify({ clientMessageId: "request_disabled" }),
    })
    expect(startLegacy).not.toHaveBeenCalled()
    expect(onTaskGraphStarted).not.toHaveBeenCalled()
  })

  it("reports the plan entitlement denial without invoking legacy execution", async () => {
    const fetcher = vi.fn(async () => response({ mode: "unavailable", reason: "not_entitled" }, 403))
    const startLegacy = vi.fn()
    const options = { clientMessageId: "request_not_entitled", startLegacy, onTaskGraphStarted: vi.fn(), fetcher }

    await expect(dispatchAgentDiscoveryStart(options)).resolves.toEqual({ mode: "unavailable", reason: "not_entitled" })
    expect(startLegacy).not.toHaveBeenCalled()
  })

  it("never starts the legacy stream when the server accepts a task graph run", async () => {
    const result = { mode: "task_graph", sessionId: "session_1", turnId: "turn_1", disposition: "started" }
    const fetcher = vi.fn(async () => response(result, 202))
    const startLegacy = vi.fn()
    const onTaskGraphStarted = vi.fn()

    await expect(dispatchAgentDiscoveryStart({
      clientMessageId: "request_task_graph",
      onTaskGraphStarted,
      fetcher,
    })).resolves.toEqual(result)

    expect(onTaskGraphStarted).toHaveBeenCalledWith(result)
  })

  it("fails closed on network or malformed responses without opening the legacy stream", async () => {
    const startLegacy = vi.fn()
    const onTaskGraphStarted = vi.fn()
    const fetcher = vi.fn(async () => response({ mode: "task_graph", sessionId: "session_1" }, 202))

    const options = { clientMessageId: "request_bad", startLegacy, onTaskGraphStarted, fetcher }
    await expect(dispatchAgentDiscoveryStart(options)).rejects.toThrow("Invalid Agent discovery response")
    expect(startLegacy).not.toHaveBeenCalled()
  })
})
