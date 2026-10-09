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

  it("releases the identical route identity through an idempotent pre-provider operation", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ status: "authorized", operationId: "agent-usage-1" }))
      .mockResolvedValueOnce(response({ status: "released" }))
      .mockResolvedValueOnce(response({ status: "released" }))
    const authorizer = createWorkerUsageAuthorizer({ endpointUrl: "https://applymate.example/api/internal/agent-runtime/usage", secret: "secret", fetch: fetcher })
    const reservation = await authorizer(input)
    await reservation.release?.()
    await reservation.release?.()
    expect(fetcher).toHaveBeenCalledTimes(3)
    for (const call of fetcher.mock.calls.slice(1)) {
      expect(JSON.parse(String(call[1]?.body))).toEqual({ operation: "release", input })
    }
  })

  it.each([
    { status: 409, code: "usage_attempt_in_flight" },
    { status: 409, code: "usage_attempt_settled" },
    { status: 409, code: "usage_attempt_conflict" },
    { status: 400, code: "invalid_usage_request" },
  ])("does not compensate or retry authorization failure $code", async ({ status, code }) => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ code }, status))
    const authorizer = createWorkerUsageAuthorizer({ endpointUrl: "https://applymate.example/api/internal/agent-runtime/usage", secret: "secret", fetch: fetcher })

    await expect(authorizer(input)).rejects.toMatchObject({ code })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ operation: "authorize", input })
  })

  it("does not retry malformed successful release responses", async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error("authorization transport outage"))
      .mockResolvedValueOnce(response("unexpected success payload"))
    const authorizer = createWorkerUsageAuthorizer({ endpointUrl: "https://applymate.example/api/internal/agent-runtime/usage", secret: "secret", fetch: fetcher })

    await expect(authorizer(input)).rejects.toMatchObject({ code: "usage_broker_unavailable" })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("retries transient compensating releases with the identical operation identity", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: "usage_broker_unavailable" }, 503))
      .mockRejectedValueOnce(new Error("temporary release transport outage"))
      .mockResolvedValueOnce(response({ code: "usage_broker_unavailable" }, 503))
      .mockResolvedValueOnce(response({ status: "released" }))
    const authorizer = createWorkerUsageAuthorizer({ endpointUrl: "https://applymate.example/api/internal/agent-runtime/usage", secret: "secret", fetch: fetcher })

    await expect(authorizer(input)).rejects.toMatchObject({ code: "usage_broker_unavailable" })
    expect(fetcher).toHaveBeenCalledTimes(4)
    const operations = fetcher.mock.calls.map(call => JSON.parse(String(call[1]?.body)) as { operation: string; input: unknown })
    expect(operations.map(body => body.operation)).toEqual(["authorize", "release", "release", "release"])
    for (const body of operations.slice(1)) expect(body).toEqual({ operation: "release", input })
  })

  it("preserves the original authorization denial after compensating release retries exhaust", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: "usage_broker_unavailable" }, 503))
      .mockRejectedValueOnce(new Error("release transport outage 1"))
      .mockRejectedValueOnce(new Error("release transport outage 2"))
      .mockRejectedValueOnce(new Error("release transport outage 3"))
    const authorizer = createWorkerUsageAuthorizer({ endpointUrl: "https://applymate.example/api/internal/agent-runtime/usage", secret: "secret", fetch: fetcher })

    await expect(authorizer(input)).rejects.toMatchObject({ code: "usage_broker_unavailable" })
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(fetcher.mock.calls.slice(1).map(call => JSON.parse(String(call[1]?.body)))).toEqual(
      Array.from({ length: 3 }, () => ({ operation: "release", input })),
    )
  })

  it.each([
    { status: 409, code: "usage_attempt_in_flight" },
    { status: 409, code: "usage_attempt_settled" },
    { status: 409, code: "usage_attempt_conflict" },
    { status: 400, code: "invalid_usage_request" },
    { status: 403, code: "usage_fence_rejected" },
  ])("does not retry compensating release for $code", async ({ status, code }) => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error("authorization transport outage"))
      .mockResolvedValueOnce(response({ code }, status))
    const authorizer = createWorkerUsageAuthorizer({ endpointUrl: "https://applymate.example/api/internal/agent-runtime/usage", secret: "secret", fetch: fetcher })

    await expect(authorizer(input)).rejects.toMatchObject({ code: "usage_broker_unavailable" })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("does not release a provider-started attempt after terminal error settlement", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ status: "authorized", operationId: "agent-usage-1" }))
      .mockResolvedValueOnce(response({ status: "settled" }))
    const authorizer = createWorkerUsageAuthorizer({ endpointUrl: "https://applymate.example/api/internal/agent-runtime/usage", secret: "secret", fetch: fetcher })
    const reservation = await authorizer(input)

    await reservation.settle({ status: "error", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, errorCode: "provider_error" })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls.map(call => JSON.parse(String(call[1]?.body)).operation)).toEqual(["authorize", "settle"])
  })

  it("accepts a child Task owner envelope without retaining root lease fields", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ status: "authorized", operationId: "child-usage-1" }))
    const { leaseOwnerId: _leaseOwnerId, leaseVersion: _leaseVersion, ...common } = input
    const childInput = {
      ...common,
      executionOwner: { kind: "task" as const, taskId: "child-1", rootTaskId: "root-1", ownerId: "child-worker", attemptCount: 2 },
    }
    const authorizer = createWorkerUsageAuthorizer({ endpointUrl: "https://applymate.example/api/internal/agent-runtime/usage", secret: "secret", fetch: fetcher })
    await authorizer(childInput)
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual(expect.objectContaining({ operation: "authorize", input: childInput }))
  })

  it("rejects a mixed legacy and child owner", async () => {
    const fetcher = vi.fn()
    const authorizer = createWorkerUsageAuthorizer({ endpointUrl: "https://applymate.example/api/internal/agent-runtime/usage", secret: "secret", fetch: fetcher })
    await expect(authorizer({ ...input, executionOwner: { kind: "task", taskId: "child-1", rootTaskId: "root-1", ownerId: "child-worker", attemptCount: 2 } } as never)).rejects.toMatchObject({ code: "usage_context_unavailable" })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("releases an uncertain admission by the same deterministic attempt identity without retrying authorization", async () => {
    const operations: unknown[] = []
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { operation: string; input: unknown }
      operations.push(body)
      return body.operation === "authorize"
        ? response({ code: "provider_error", error: "secret key leaked" }, 503)
        : response({ status: "released" })
    })
    const authorizer = createWorkerUsageAuthorizer({ endpointUrl: "https://applymate.example/api/internal/agent-runtime/usage", secret: "secret", fetch: fetcher })
    await expect(authorizer(input)).rejects.toMatchObject({ code: "usage_broker_unavailable" })
    try { await authorizer(input) } catch (error) {
      expect(error).toBeInstanceOf(UsageBridgeError)
      expect(String(error)).not.toContain("secret key leaked")
    }
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(operations.map(value => (value as { operation: string }).operation)).toEqual(["authorize", "release", "authorize", "release"])
    expect(operations[1]).toEqual({ operation: "release", input })
    expect(operations[3]).toEqual({ operation: "release", input })
  })
})
