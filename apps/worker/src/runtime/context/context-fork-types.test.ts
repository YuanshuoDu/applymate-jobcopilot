import { describe, expect, it } from "vitest"

import { ContextForkError } from "./context-fork-types.js"

describe("context fork contract types", () => {
  it("exposes a typed fork boundary error", () => {
    const error = new ContextForkError("boundary_active", "boundary is active")
    expect(error).toMatchObject({ name: "ContextForkError", code: "boundary_active" })
  })
})
