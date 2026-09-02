import { describe, expect, it } from "vitest"

import { assertInterruptTarget, interruptTargetKey } from "./types.js"

const target = { userId: "user-1", sessionId: "session-1", turnId: "turn-1" }

describe("interrupt target contract", () => {
  it("validates only identity fields and accepts request metadata", () => {
    const request = { ...target, requestedAt: new Date() }
    const evidence = { ...target, startedAt: new Date(), payload: { reason: "stop" } }
    expect(() => assertInterruptTarget(request)).not.toThrow()
    expect(() => assertInterruptTarget(evidence)).not.toThrow()
    expect(interruptTargetKey(request)).toBe("user-1:session-1:turn-1")
  })

  it("rejects an empty required identity without inspecting optional fields", () => {
    const invalid = { ...target, sessionId: "", payload: { sessionId: "metadata" } }
    expect(() => assertInterruptTarget(invalid)).toThrow("sessionId")
  })
})
