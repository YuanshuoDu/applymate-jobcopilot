import { describe, expect, it, vi } from "vitest"

import { createWorkerUsageAuthorizer, negotiatedRootOutputBudgetDisposition, UsageBridgeError } from "./ai-usage-bridge.js"

const input = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", stepId: "step-1", leaseOwnerId: "worker-1", leaseVersion: 2,
  featureKey: "agent", provider: "minimax", model: "MiniMax-M3", attemptId: "provider-attempt-1", requestedOutputTokens: 256,
}
const protocolInput = { ...input, startProtocolVersion: 1 as const }
const classifiedProtocolInput = { ...protocolInput, outputBudgetClassificationVersion: 1 as const }

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
      .mockResolvedValueOnce(response({ status: "authorized", operationId: "agent-usage-1", startProtocolVersion: 1, outputReservationRequired: true, maxOutputTokens: 128 }))
      .mockResolvedValueOnce(response({ status: "started", startProtocolVersion: 1, outputReservationRequired: true, maxOutputTokens: 128 }))
      .mockResolvedValueOnce(response({ status: "settled" }))
    const authorizer = createWorkerUsageAuthorizer({ endpointUrl: "https://applymate.example/api/internal/agent-runtime/usage", secret: "secret", fetch: fetcher })
    const reservation = await authorizer(input)
    await expect(reservation.start()).resolves.toBe(128)
    await expect(reservation.start()).rejects.toMatchObject({ code: "usage_start_replayed" })
    await reservation.settle({ status: "success", inputTokens: 4, outputTokens: 2, estimatedCostUsd: 0.001 })
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://applymate.example/api/internal/agent-runtime/usage")
    expect(fetcher.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ headers: expect.objectContaining({ "x-agent-worker-secret": "secret" }) }))
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ operation: "authorize", input: protocolInput })
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ operation: "start", input: { ...protocolInput, operationId: "agent-usage-1" } })
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual(expect.objectContaining({ operation: "settle", input: expect.objectContaining({ operationId: "agent-usage-1", userId: "user-1", provider: "minimax", model: "MiniMax-M3" }) }))
  })

  it("does not accept an input field as classification opt-in", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ status: "authorized", operationId: "agent-usage-1", startProtocolVersion: 1, outputReservationRequired: false, maxOutputTokens: null }))
      .mockResolvedValueOnce(response({ status: "started", startProtocolVersion: 1, outputReservationRequired: false, maxOutputTokens: null }))
      .mockResolvedValueOnce(response({ status: "released" }))
    const authorizer = createWorkerUsageAuthorizer({ endpointUrl: "https://applymate.example/api/internal/agent-runtime/usage", secret: "secret", fetch: fetcher })

    const reservation = await authorizer({ ...input, outputBudgetClassificationVersion: 1 } as never)
    await reservation.start()
    await reservation.release?.()

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ operation: "authorize", input: protocolInput })
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ operation: "start", input: { ...protocolInput, operationId: "agent-usage-1" } })
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({ operation: "release", input: protocolInput })
  })

  it("opts in only on authorize and keeps start and release request shapes version-stable", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ status: "authorized", operationId: "agent-usage-1", startProtocolVersion: 1, outputReservationRequired: false, maxOutputTokens: null, outputBudgetClassificationVersion: 1 }))
      .mockResolvedValueOnce(response({ status: "started", startProtocolVersion: 1, outputReservationRequired: false, maxOutputTokens: null }))
      .mockResolvedValueOnce(response({ status: "released" }))
    const authorizer = createWorkerUsageAuthorizer({ endpointUrl: "https://applymate.example/api/internal/agent-runtime/usage", secret: "secret", fetch: fetcher, outputBudgetClassificationVersion: 1 })

    const reservation = await authorizer(input)
    await reservation.start()
    await reservation.release?.()

    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ operation: "authorize", input: classifiedProtocolInput })
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ operation: "start", input: { ...protocolInput, operationId: "agent-usage-1" } })
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({ operation: "release", input: protocolInput })
  })

  it("accepts an older Web success response that does not echo the optional classification version", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ status: "authorized", operationId: "agent-usage-1", startProtocolVersion: 1, outputReservationRequired: true, maxOutputTokens: 128 }))
      .mockResolvedValueOnce(response({ status: "started", startProtocolVersion: 1, outputReservationRequired: true, maxOutputTokens: 128 }))
    const authorizer = createWorkerUsageAuthorizer({ endpointUrl: "https://applymate.example/api/internal/agent-runtime/usage", secret: "secret", fetch: fetcher, outputBudgetClassificationVersion: 1 })

    const reservation = await authorizer(input)
    await expect(reservation.start()).resolves.toBe(128)

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ operation: "authorize", input: classifiedProtocolInput })
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ operation: "start", input: { ...protocolInput, operationId: "agent-usage-1" } })
  })

  it("keeps an older Web 429 denial unclassified and does not retry or release it", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ code: "output_budget_exhausted", error: "private server detail" }, 429))
    const authorizer = createWorkerUsageAuthorizer({ endpointUrl: "https://applymate.example/api/internal/agent-runtime/usage", secret: "secret", fetch: fetcher, outputBudgetClassificationVersion: 1 })

    let caught: unknown
    try { await authorizer(input) } catch (error: unknown) { caught = error }
    expect(caught).toBeInstanceOf(UsageBridgeError)
    expect(caught).toMatchObject({ code: "output_budget_exhausted", retryable: false, outputBudgetDisposition: undefined })
    expect(String(caught)).not.toContain("private server detail")
    expect(fetcher).toHaveBeenCalledOnce()
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ operation: "authorize", input: classifiedProtocolInput })
  })

  it("does not consume a classified response when the bridge has not opted in", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({
      code: "output_budget_exhausted", outputBudgetClassificationVersion: 1, outputBudgetDisposition: "settled_exhausted",
    }, 429))
    const authorizer = createWorkerUsageAuthorizer({ endpointUrl: "https://applymate.example/api/internal/agent-runtime/usage", secret: "secret", fetch: fetcher })

    let caught: unknown
    try { await authorizer(input) } catch (error: unknown) { caught = error }
    expect(caught).toMatchObject({ code: "output_budget_exhausted", outputBudgetDisposition: undefined })
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ operation: "authorize", input: protocolInput })
  })

  it.each([
    "configured_zero_limit",
    "settled_exhausted",
    "active_reservation_hold",
  ] as const)("attaches the bounded v1 disposition %s only to a matching authorize 429", async disposition => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({
      code: "output_budget_exhausted", error: "private server detail",
      outputBudgetClassificationVersion: 1, outputBudgetDisposition: disposition,
    }, 429))
    const authorizer = createWorkerUsageAuthorizer({ endpointUrl: "https://applymate.example/api/internal/agent-runtime/usage", secret: "secret", fetch: fetcher, outputBudgetClassificationVersion: 1 })

    let caught: unknown
    try { await authorizer(input) } catch (error: unknown) { caught = error }
    expect(caught).toBeInstanceOf(UsageBridgeError)
    expect(caught).toMatchObject({ code: "output_budget_exhausted", retryable: false, outputBudgetDisposition: disposition })
    expect(negotiatedRootOutputBudgetDisposition(caught)).toBe(disposition)
    expect(String(caught)).not.toContain("private server detail")
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it("keeps negotiated classification Root-only even if a task caller receives a v1-capable authorizer", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({
      code: "output_budget_exhausted", outputBudgetClassificationVersion: 1, outputBudgetDisposition: "active_reservation_hold",
    }, 429))
    const authorizer = createWorkerUsageAuthorizer({ endpointUrl: "https://applymate.example/api/internal/agent-runtime/usage", secret: "secret", fetch: fetcher, outputBudgetClassificationVersion: 1 })
    const { leaseOwnerId: _leaseOwnerId, leaseVersion: _leaseVersion, ...common } = input

    let caught: unknown
    try {
      await authorizer({ ...common, executionOwner: { kind: "task", taskId: "child-1", rootTaskId: "root-1", ownerId: "worker-1", attemptCount: 2 } })
    } catch (error: unknown) { caught = error }

    expect(caught).toMatchObject({ code: "output_budget_exhausted", outputBudgetDisposition: undefined })
    expect(negotiatedRootOutputBudgetDisposition(caught)).toBeUndefined()
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ operation: "authorize", input: {
      ...common, executionOwner: { kind: "task", taskId: "child-1", rootTaskId: "root-1", ownerId: "worker-1", attemptCount: 2 }, startProtocolVersion: 1,
    } })
  })

  it("does not trust manually constructed UsageBridgeErrors with a disposition", () => {
    const forged = new UsageBridgeError("output_budget_exhausted", "output_budget_exhausted", false, "settled_exhausted")
    expect(negotiatedRootOutputBudgetDisposition(forged)).toBeUndefined()
  })

  it("keeps the parsed v1 disposition immutable if the error property is later changed", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({
      code: "output_budget_exhausted", outputBudgetClassificationVersion: 1, outputBudgetDisposition: "active_reservation_hold",
    }, 429))
    const authorizer = createWorkerUsageAuthorizer({ endpointUrl: "https://applymate.example/api/internal/agent-runtime/usage", secret: "secret", fetch: fetcher, outputBudgetClassificationVersion: 1 })
    let caught: unknown
    try { await authorizer(input) } catch (error: unknown) { caught = error }

    expect(caught).toBeInstanceOf(UsageBridgeError)
    Object.defineProperty(caught, "outputBudgetDisposition", { value: "settled_exhausted", configurable: true })
    expect((caught as UsageBridgeError).outputBudgetDisposition).toBe("settled_exhausted")
    expect(negotiatedRootOutputBudgetDisposition(caught)).toBe("active_reservation_hold")
  })

  it.each([
    { name: "unsupported version", status: 429, code: "output_budget_exhausted", version: 2, disposition: "settled_exhausted" },
    { name: "unknown disposition", status: 429, code: "output_budget_exhausted", version: 1, disposition: "future_state" },
    { name: "non-budget code", status: 429, code: "ai_credits_exhausted", version: 1, disposition: "settled_exhausted" },
    { name: "non-429 status", status: 403, code: "output_budget_exhausted", version: 1, disposition: "settled_exhausted" },
  ])("does not classify $name", async ({ status, code, version, disposition }) => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({
      code, error: "private server detail", outputBudgetClassificationVersion: version, outputBudgetDisposition: disposition,
    }, status))
    const authorizer = createWorkerUsageAuthorizer({ endpointUrl: "https://applymate.example/api/internal/agent-runtime/usage", secret: "secret", fetch: fetcher, outputBudgetClassificationVersion: 1 })

    let caught: unknown
    try { await authorizer(input) } catch (error: unknown) { caught = error }
    expect(caught).toBeInstanceOf(UsageBridgeError)
    expect(caught).toMatchObject({ outputBudgetDisposition: undefined })
    expect(String(caught)).not.toContain("private server detail")
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it("does not negotiate unsupported classification versions", () => {
    expect(() => createWorkerUsageAuthorizer({ outputBudgetClassificationVersion: 2 as unknown as 1 })).toThrow(RangeError)
  })

  it("releases the identical route identity through an idempotent pre-provider operation", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ status: "authorized", operationId: "agent-usage-1", startProtocolVersion: 1, outputReservationRequired: false, maxOutputTokens: null }))
      .mockResolvedValueOnce(response({ status: "released" }))
      .mockResolvedValueOnce(response({ status: "released" }))
    const authorizer = createWorkerUsageAuthorizer({ endpointUrl: "https://applymate.example/api/internal/agent-runtime/usage", secret: "secret", fetch: fetcher })
    const reservation = await authorizer(input)
    await reservation.release?.()
    await reservation.release?.()
    expect(fetcher).toHaveBeenCalledTimes(3)
    for (const call of fetcher.mock.calls.slice(1)) {
      expect(JSON.parse(String(call[1]?.body))).toEqual({ operation: "release", input: protocolInput })
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
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ operation: "authorize", input: protocolInput })
  })

  it("does not retry malformed successful release responses", async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error("authorization transport outage"))
      .mockResolvedValueOnce(response("unexpected success payload"))
    const authorizer = createWorkerUsageAuthorizer({ endpointUrl: "https://applymate.example/api/internal/agent-runtime/usage", secret: "secret", fetch: fetcher })

    await expect(authorizer(input)).rejects.toMatchObject({ code: "usage_broker_unavailable" })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("rejects an unexpected successful release status without retrying", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ status: "authorized", operationId: "agent-usage-1", startProtocolVersion: 1, outputReservationRequired: false, maxOutputTokens: null }))
      .mockResolvedValueOnce(response({ status: "still_reserved" }))
    const authorizer = createWorkerUsageAuthorizer({ endpointUrl: "https://applymate.example/api/internal/agent-runtime/usage", secret: "secret", fetch: fetcher })
    const reservation = await authorizer(input)

    await expect(reservation.release?.()).rejects.toMatchObject({ code: "usage_broker_unavailable" })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ operation: "release", input: protocolInput })
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
    for (const body of operations.slice(1)) expect(body).toEqual({ operation: "release", input: protocolInput })
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
      Array.from({ length: 3 }, () => ({ operation: "release", input: protocolInput })),
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
      .mockResolvedValueOnce(response({ status: "authorized", operationId: "agent-usage-1", startProtocolVersion: 1, outputReservationRequired: false, maxOutputTokens: null }))
      .mockResolvedValueOnce(response({ status: "started", startProtocolVersion: 1, outputReservationRequired: false, maxOutputTokens: null }))
      .mockResolvedValueOnce(response({ status: "settled" }))
    const authorizer = createWorkerUsageAuthorizer({ endpointUrl: "https://applymate.example/api/internal/agent-runtime/usage", secret: "secret", fetch: fetcher })
    const reservation = await authorizer(input)

    await reservation.start()
    await reservation.settle({ status: "error", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, errorCode: "provider_error" })
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(fetcher.mock.calls.map(call => JSON.parse(String(call[1]?.body)).operation)).toEqual(["authorize", "start", "settle"])
  })

  it("accepts a child Task owner envelope without retaining root lease fields", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ status: "authorized", operationId: "child-usage-1", startProtocolVersion: 1, outputReservationRequired: false, maxOutputTokens: null }))
    const { leaseOwnerId: _leaseOwnerId, leaseVersion: _leaseVersion, ...common } = input
    const childInput = {
      ...common,
      executionOwner: { kind: "task" as const, taskId: "child-1", rootTaskId: "root-1", ownerId: "child-worker", attemptCount: 2 },
    }
    const authorizer = createWorkerUsageAuthorizer({ endpointUrl: "https://applymate.example/api/internal/agent-runtime/usage", secret: "secret", fetch: fetcher })
    await authorizer(childInput)
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ operation: "authorize", input: { ...childInput, startProtocolVersion: 1 } })
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
    expect(operations[1]).toEqual({ operation: "release", input: protocolInput })
    expect(operations[3]).toEqual({ operation: "release", input: protocolInput })
  })
})
