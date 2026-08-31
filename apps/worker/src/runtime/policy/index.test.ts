import { describe, expect, it } from "vitest"

import { PolicyEngine, POLICY_VERSION } from "./index.js"

describe("policy runtime exports", () => {
  it("exposes the versioned engine through the runtime entrypoint", () => {
    expect(PolicyEngine).toBeTypeOf("function")
    expect(POLICY_VERSION).toBe("policy.v1")
  })
})
