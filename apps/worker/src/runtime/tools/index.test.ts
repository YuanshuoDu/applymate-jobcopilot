import { describe, expect, it } from "vitest"

import { createWorkerToolRuntime } from "./index.js"

describe("worker tool runtime entry point", () => {
  it("exports a factory without opening a database connection at import time", () => {
    expect(createWorkerToolRuntime).toBeTypeOf("function")
  })
})
