import { describe, expect, it, vi } from "vitest"

import { createJobDiscoveryClient, JobDiscoveryClientError, type JobDiscoveryRequest } from "./job-discovery-client.js"

const request: JobDiscoveryRequest = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", stepId: "step-1", toolCallId: "call-1",
  taskId: "child-1", rootTaskId: "root-1", role: "scout", leaseOwner: "worker-1", attemptCount: 2,
  targetRoles: ["Engineer"], targetLocations: ["Dublin"], pageSize: 2,
}
const output = { jobs: [], evidence: [], nextCursor: null, usage: {} }

describe("Worker job discovery client", () => {
  it("uses the authenticated internal Web route and returns its canonical result", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json(output))
    const client = createJobDiscoveryClient({ endpointUrl: "https://web.example/api/internal/agent-runtime/discovery/search", secret: "worker-secret", fetch: fetcher })
    const result = await client.discover(request, new AbortController().signal)
    const [url, init] = fetcher.mock.calls[0]!

    expect(url).toBe("https://web.example/api/internal/agent-runtime/discovery/search")
    expect(init).toMatchObject({ method: "POST", headers: { "x-agent-worker-secret": "worker-secret" }, cache: "no-store", redirect: "error" })
    expect(JSON.parse(String(init?.body))).toEqual(request)
    expect(result).toEqual(output)
  })

  it("propagates cancellation to the request and reports a cancelled call", async () => {
    let requestSignal: AbortSignal | null | undefined
    const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      requestSignal = init?.signal
      requestSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
    }))
    const client = createJobDiscoveryClient({ endpointUrl: "https://web.example/discovery", secret: "secret", fetch: fetcher })
    const controller = new AbortController()
    const pending = client.discover(request, controller.signal)
    await Promise.resolve()
    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: "cancelled" })
    expect(requestSignal?.aborted).toBe(true)
  })

  it("bounds request time and response bytes", async () => {
    const stalledFetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
    }))
    const timeoutClient = createJobDiscoveryClient({ endpointUrl: "https://web.example/discovery", secret: "secret", fetch: stalledFetch, timeoutMs: 5 })
    await expect(timeoutClient.discover(request, new AbortController().signal)).rejects.toMatchObject({ code: "timeout" })

    const largeClient = createJobDiscoveryClient({
      endpointUrl: "https://web.example/discovery", secret: "secret", fetch: vi.fn(async () => new Response("x".repeat(100))), maxResponseBytes: 16,
    })
    await expect(largeClient.discover(request, new AbortController().signal)).rejects.toMatchObject({ code: "job_discovery_response_too_large" })
  })

  it("maps internal route errors to safe codes and rejects malformed success bodies", async () => {
    const failed = createJobDiscoveryClient({
      endpointUrl: "https://web.example/discovery", secret: "secret",
      fetch: vi.fn(async () => Response.json({ error: { code: "stale_attempt", message: "private details" } }, { status: 409 })),
    })
    await expect(failed.discover(request, new AbortController().signal)).rejects.toMatchObject({ code: "stale_attempt" })
    const invalid = createJobDiscoveryClient({ endpointUrl: "https://web.example/discovery", secret: "secret", fetch: vi.fn(async () => new Response("not-json")) })
    await expect(invalid.discover(request, new AbortController().signal)).rejects.toBeInstanceOf(JobDiscoveryClientError)
  })

  it("drops malformed usage metrics from error responses", async () => {
    const client = createJobDiscoveryClient({
      endpointUrl: "https://web.example/discovery", secret: "secret",
      fetch: vi.fn(async () => Response.json({
        error: { code: "provider_unavailable" },
        usage: {
          requests: -1, jobsProcessed: 1, jobsSucceeded: 0, jobsFailed: 1, providerFailures: 1,
          providers: ["greenhouse"], estimatedCostUsd: 0, durationMs: 10,
        },
      }, { status: 502 })),
    })

    const failure = client.discover(request, new AbortController().signal)
    await expect(failure).rejects.toMatchObject({ code: "provider_unavailable" })
    await expect(failure).rejects.toHaveProperty("usage", undefined)
  })
})
