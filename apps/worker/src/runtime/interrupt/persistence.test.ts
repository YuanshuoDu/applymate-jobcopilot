import { describe, expect, it } from "vitest"

import { InMemoryInterruptPersistence } from "./persistence.js"

const target = { userId: "user-1", sessionId: "session-1", turnId: "turn-1" }
const requestedAt = new Date("2026-09-02T10:00:00.000Z")

describe("interrupt persistence port", () => {
  it("is durable and idempotent for concurrent Stop requests", async () => {
    const persistence = new InMemoryInterruptPersistence()
    const [first, second] = await Promise.all([
      persistence.persist({ ...target, requestId: "stop-1", requestedAt, reason: "user_stop" }),
      persistence.persist({ ...target, requestId: "stop-2", requestedAt, reason: "duplicate_stop" }),
    ])
    expect([first.disposition, second.disposition].sort()).toEqual(["accepted", "duplicate"])
    expect(first.persistedAt).toEqual(requestedAt)
    expect(second.requestId).toBe("stop-2")
    const lookupTarget = { ...target, payload: { source: "control-plane" } }
    await expect(persistence.isRequested(lookupTarget)).resolves.toBe(true)
  })
})
