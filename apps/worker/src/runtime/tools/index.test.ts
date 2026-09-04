import { describe, expect, it } from "vitest"

import { createWorkerToolRuntime } from "./index.js"
import { InMemoryToolLifecycleSink } from "./lifecycle.js"

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
})
