import { describe, expect, it } from "vitest"

import { protocolScope } from "./types.js"

describe("worker approval types", () => {
  it("uses the same UTC protocol representation as the Web store", () => {
    const scope = protocolScope({
      userId: "user_1", sessionId: "session_1", turnId: "turn_1", jobId: "job_1", toolCallId: "call_1", action: "submit_application",
      resourceHash: "a".repeat(64), materialHash: "b".repeat(64), answersHash: "c".repeat(64), revision: 1,
      expiresAt: new Date("2026-08-31T01:00:00.000Z"),
    }, "d".repeat(64))
    expect(scope.expiresAt).toBe("2026-08-31T01:00:00.000Z")
  })
})
