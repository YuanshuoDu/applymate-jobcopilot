import { describe, expect, it } from "vitest"

import { createWorkerToolRuntime } from "./index.js"
import { InMemoryToolLifecycleSink } from "./lifecycle.js"
import type { ExecutionOwner } from "../execution-owner.js"

const owner: ExecutionOwner = {
  kind: "turn", taskId: "root-1", lease: {
    turnId: "turn-1", sessionId: "session-1", ownerId: "worker-1", userId: "user-1", leaseVersion: 1,
    leaseStartedAt: new Date("2026-08-31T11:59:00.000Z"), leaseExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
  },
}

describe("worker tool runtime entry point", () => {
  it("exports a factory without opening a database connection at import time", () => {
    expect(createWorkerToolRuntime).toBeTypeOf("function")
  })

  it("adds write tools only when a provider is explicitly supplied", () => {
    const runtime = createWorkerToolRuntime(
      {} as never,
      { sink: new InMemoryToolLifecycleSink() },
      undefined,
      undefined,
      undefined,
      undefined,
      { submit: async () => ({ confirmationId: "mock-confirmation" }) },
    )

    expect(runtime.registry.resolve("application.submit", "1").risk).toBe("external_write")
  })

  it("registers the durable private-result read tool with the runtime owner resolver", () => {
    const runtime = createWorkerToolRuntime(
      {} as never,
      { sink: new InMemoryToolLifecycleSink(), resolveOwner: () => owner },
    )

    expect(runtime.registry.resolve("tool_results.read", "1")).toMatchObject({ risk: "read", domain: "coordination" })
  })
})
