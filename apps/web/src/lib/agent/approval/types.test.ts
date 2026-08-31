import { describe, expect, it } from "vitest"

import { protocolScope } from "./types"

describe("approval store types", () => {
  it("normalizes dates only at the protocol boundary", () => {
    const scope = protocolScope({
      userId: "user_1", sessionId: "session_1", turnId: "turn_1", jobId: "job_1", toolCallId: "call_1",
      action: "submit_application", resourceHash: "a".repeat(64), materialHash: "b".repeat(64),
      answersHash: "c".repeat(64), revision: 2, expiresAt: new Date("2026-08-31T01:00:00.000Z"),
    }, "d".repeat(64))

    expect(scope.expiresAt).toBe("2026-08-31T01:00:00.000Z")
    expect(scope.revision).toBe(2)
  })
})
