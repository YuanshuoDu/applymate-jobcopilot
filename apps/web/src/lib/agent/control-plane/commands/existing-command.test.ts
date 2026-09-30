import { describe, expect, it, vi } from "vitest"

import { fallbackDisposition, findExistingCommand } from "./existing-command"
import type { CommandTransaction } from "./transaction"

describe("existing command helpers", () => {
  it("loads the prior input needed for command idempotency", async () => {
    const prior = { id: "input", targetTurnId: "turn", delivery: "follow_up", acceptedSequence: BigInt(4) }
    const findFirst = vi.fn().mockResolvedValue(prior)

    await expect(findExistingCommand({ agentInput: { findFirst } } as unknown as CommandTransaction, "session", "message"))
      .resolves.toEqual(prior)
    expect(findFirst).toHaveBeenCalledWith({
      where: { sessionId: "session", clientMessageId: "message" },
      select: { id: true, targetTurnId: true, delivery: true, acceptedSequence: true },
    })
  })

  it("recovers the original delivery disposition when event data is unavailable", () => {
    const prior = { id: "input", targetTurnId: "turn", delivery: "follow_up", acceptedSequence: BigInt(4) }
    expect(fallbackDisposition(prior, "follow_up")).toBe("queued_follow_up")
    expect(fallbackDisposition(prior, "steer")).toBe("steered")
  })
})
