import { describe, expect, it, vi } from "vitest"

import { createWorkerUsageAuthorizer, UsageBridgeError } from "./ai-usage-bridge.js"

const input = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", stepId: "step-1", leaseOwnerId: "worker-1", leaseVersion: 2,
  featureKey: "agent", provider: "minimax", model: "MiniMax-M3", attemptId: "provider-attempt-1",
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
}

describe("Worker AI usage bridge", () => {
  it("fails closed before any request when the endpoint or fence context is unavailable", async () => {
    const fetcher = vi.fn()
    const authorizer = createWorkerUsageAuthorizer({ secret: "secret", fetch: fetcher })
    await expect(authorizer(input)).rejects.toMatchObject({ code: "usage_authorization_unavailable" })
    expect(fetcher).not.toHaveBeenCalled()
    await expect(authorizer({ ...input, leaseOwnerId: "" })).rejects.toMatchObject({ code: "usage_context_unavailable" })
  })

  it("authorizes and settles one provider attempt with the Worker secret", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ status: "authorized", operationId: "agent-usage-1" }))
      .mockResolvedValueOnce(response({ status: "settled" }))
    const authorizer = createWorkerUsageAuthorizer({ endpointUrl: "https://applymate.example/api/internal/agent-runtime/usage", secret: "secret", fetch: fetcher })
    const reservation = await authorizer(input)
    await reservation.settle({ status: "success", inputTokens: 4, outputTokens: 2, estimatedCostUsd: 0.001 })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://applymate.example/api/internal/agent-runtime/usage")
    expect(fetcher.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ headers: expect.objectContaining({ "x-agent-worker-secret": "secret" }) }))
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual(expect.objectContaining({ operation: "authorize", input }))
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual(expect.objectContaining({ operation: "settle", input: expect.objectContaining({ operationId: "agent-usage-1", userId: "user-1", provider: "minimax", model: "MiniMax-M3" }) }))
  })

  it("does not retry an uncertain admission or expose response text", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ code: "provider_error", error: "secret key leaked" }, 503))
    const authorizer = createWorkerUsageAuthorizer({ endpointUrl: "https://applymate.example/api/internal/agent-runtime/usage", secret: "secret", fetch: fetcher })
    await expect(authorizer(input)).rejects.toMatchObject({ code: "usage_broker_unavailable" })
    expect(fetcher).toHaveBeenCalledOnce()
    try { await authorizer(input) } catch (error) {
      expect(error).toBeInstanceOf(UsageBridgeError)
      expect(String(error)).not.toContain("secret key leaked")
    }
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
