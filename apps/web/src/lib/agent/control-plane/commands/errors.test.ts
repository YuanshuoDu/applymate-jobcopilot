import { describe, expect, it } from "vitest"

import { activeTurnChanged, automationCannotSteerUserTurn, sessionNotFound } from "./errors"

describe("Agent command errors", () => {
  it("exposes HTTP-safe typed details", () => {
    expect(activeTurnChanged("expected", "actual")).toMatchObject({
      code: "active_turn_changed",
      status: 409,
      details: { expectedTurnId: "expected", actualTurnId: "actual" },
    })
    expect(automationCannotSteerUserTurn("turn_1").code).toBe("automation_cannot_steer_user_turn")
    expect(sessionNotFound("session_1").status).toBe(404)
  })
})
