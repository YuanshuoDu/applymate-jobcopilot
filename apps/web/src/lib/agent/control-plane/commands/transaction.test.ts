import { describe, expect, it } from "vitest"

import { assertExpectedTurn, commandEventKey, fallbackDisposition } from "./transaction"
import { activeTurnChanged } from "./errors"

describe("Agent command transaction helpers", () => {
  it("uses stable command event keys and original delivery for fallback idempotency", () => {
    expect(commandEventKey("client-1")).toBe("agent-command:client-1")
    expect(fallbackDisposition({ id: "input", targetTurnId: "turn", delivery: "follow_up", acceptedSequence: BigInt(1) }, "follow_up")).toBe("queued_follow_up")
  })

  it("guards expected turn and revision together", async () => {
    await expect(assertExpectedTurn("stale", 2, { id: "current", source: "user", status: "in_progress", revision: 3 }))
      .rejects.toMatchObject(activeTurnChanged("stale", "current"))
  })
})
