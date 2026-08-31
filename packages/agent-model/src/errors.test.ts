import { describe, expect, it } from "vitest"

import { AgentModelError, cancellationError, isAgentModelError } from "./errors.js"

describe("agent model errors", () => {
  it("keeps retry and recovery metadata without exposing causes or credentials", () => {
    const error = new AgentModelError({
      code: "provider_error", message: "Provider request failed", provider: "custom", model: "private-model",
      retryable: true, recoverable: true, retryAfterMs: 250,
    })
    expect(isAgentModelError(error)).toBe(true)
    expect(error.descriptor()).toEqual({
      code: "provider_error", message: "Provider request failed", provider: "custom", model: "private-model",
      retryable: true, recoverable: true, retryAfterMs: 250,
    })
    expect(JSON.stringify(error.descriptor())).not.toContain("apiKey")
  })

  it("represents cancellation as recoverable and typed", () => {
    expect(cancellationError({ provider: "minimax", model: "MiniMax-M3" }).descriptor()).toMatchObject({
      code: "cancelled", recoverable: true, retryable: false,
    })
  })
})
