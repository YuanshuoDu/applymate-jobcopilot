import { describe, expect, it } from "vitest"

import { activeTurnChanged, automationCannotSteerUserTurn, executionChanged, sessionNotFound, turnWaitRequiresDedicatedAction } from "./errors"

describe("Agent command errors", () => {
  it("exposes HTTP-safe typed details", () => {
    expect(activeTurnChanged("expected", "actual")).toMatchObject({
      code: "active_turn_changed",
      status: 409,
      details: { expectedTurnId: "expected", actualTurnId: "actual" },
    })
    expect(automationCannotSteerUserTurn("turn_1").code).toBe("automation_cannot_steer_user_turn")
    expect(turnWaitRequiresDedicatedAction("turn_1", "waiting_for_user")).toMatchObject({
      code: "turn_wait_requires_dedicated_action",
      status: 409,
      details: { turnId: "turn_1", status: "waiting_for_user" },
    })
    expect(executionChanged("execution_1")).toMatchObject({ code: "execution_changed", status: 409, details: { executionId: "execution_1" } })
    expect(sessionNotFound("session_1").status).toBe(404)
  })
})
