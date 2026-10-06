import { describe, expect, it } from "vitest"
import { MAX_SESSION_CONTROL_BODY_BYTES, parseSessionControlRequest } from "./route-helpers"

function request(body: unknown, headers: HeadersInit = {}) {
  return new Request("http://localhost/api/agent/sessions/session_1/control", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  })
}

describe("session control request parsing", () => {
  it("binds the URL-owned session and accepts a stable body or header command key", async () => {
    const parsed = await parseSessionControlRequest(request({ clientMessageId: "control_1", action: "pause", expectedTurnId: "turn_1", expectedRevision: 3 }), "session_1")
    expect(parsed).toEqual({ sessionId: "session_1", clientMessageId: "control_1", action: "pause", expectedTurnId: "turn_1", expectedRevision: 3 })
    const fromHeader = await parseSessionControlRequest(request({ action: "resume", expectedTurnId: "turn_1", expectedRevision: 4 }, { "idempotency-key": "control_2" }), "session_1")
    expect(fromHeader).toMatchObject({ clientMessageId: "control_2", action: "resume", expectedRevision: 4 })
  })

  it("rejects spoofed owner/session fields, stale key mismatch, malformed fences, and oversize bodies", async () => {
    for (const body of [
      { clientMessageId: "bad_1", action: "pause", expectedTurnId: "turn_1", expectedRevision: 1, userId: "other" },
      { clientMessageId: "bad_2", action: "pause", expectedTurnId: "turn_1", expectedRevision: 1, sessionId: "other" },
      { clientMessageId: "bad_3", action: "pause", expectedTurnId: null, expectedRevision: 1 },
      { clientMessageId: "bad_4", action: "pause", expectedTurnId: "turn_1", expectedRevision: -1 },
      { clientMessageId: "bad_5", action: "stop", expectedTurnId: "turn_1", expectedRevision: 1 },
    ]) {
      expect(await parseSessionControlRequest(request(body), "session_1")).toBeInstanceOf(Response)
    }
    expect(await parseSessionControlRequest(request({ clientMessageId: "body", action: "pause", expectedTurnId: "turn_1", expectedRevision: 1 }, { "idempotency-key": "header" }), "session_1")).toBeInstanceOf(Response)
    const tooLarge = new Request("http://localhost/control", { method: "POST", body: "x".repeat(MAX_SESSION_CONTROL_BODY_BYTES + 1) })
    expect(await parseSessionControlRequest(tooLarge, "session_1")).toBeInstanceOf(Response)
  })
})
