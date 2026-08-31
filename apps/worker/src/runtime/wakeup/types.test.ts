import { describe, expect, it } from "vitest"

import { parseWakeup } from "./types.js"

const payload = {
  eventId: "event_1", sessionId: "session_1", turnId: "turn_1", itemId: "item_1", type: "turn.wakeup",
  payload: { waitKind: "question", waitId: "question_1", itemId: "item_1", toolCallId: "call_1", status: "answered", nextTurnRevision: 5 },
}

describe("Agent Turn wakeup protocol", () => {
  it("accepts only a safe typed lineage envelope", () => {
    expect(parseWakeup(payload)).toEqual({
      eventId: "event_1", sessionId: "session_1", turnId: "turn_1", itemId: "item_1", waitKind: "question",
      waitId: "question_1", toolCallId: "call_1", status: "answered", nextTurnRevision: 5,
    })
  })

  it("rejects malformed or mismatched item lineage", () => {
    expect(parseWakeup({ ...payload, payload: { ...payload.payload, itemId: "other" } })).toBeNull()
    expect(parseWakeup({ ...payload, payload: { ...payload.payload, answer: "private" } })).not.toBeNull()
    expect(parseWakeup({ ...payload, type: "agent.session.event" })).toBeNull()
  })
})
