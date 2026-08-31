import { describe, expect, it } from "vitest"

import { mapEvent, mapItem, mapStep, mapTurn } from "./mapping.js"

const date = "2026-08-31T00:00:00.000Z"

describe("worker repository mapping", () => {
  it("normalizes pg strings and preserves BigInt sequences", () => {
    expect(mapTurn({ id: "t", sessionId: "s", userId: "u", source: "user", status: "queued", revision: 0, createdAt: date, updatedAt: date })).toMatchObject({ createdAt: date })
    expect(mapStep({ id: "st", sessionId: "s", turnId: "t", ordinal: 0, attempt: 1, status: "queued", inputThroughSequence: "4", consumedInputIds: [], modelProfileSnapshot: { model: "fixture" }, createdAt: date })).toMatchObject({ inputThroughSequence: BigInt(4) })
    expect(mapItem({ id: "i", sessionId: "s", turnId: "t", stepId: null, taskId: null, type: "agent_message", status: "started", phase: "commentary", revision: 0, content: { text: "hi" }, startedAt: null, completedAt: null, createdAt: date, updatedAt: date })).toMatchObject({ content: { text: "hi" } })
    expect(mapEvent({ id: "e", sessionId: "s", turnId: "t", itemId: null, taskId: null, sequence: "1", type: "item.started", actor: "orchestrator", correlationId: "c", causationId: null, idempotencyKey: "k", payload: { ok: true }, createdAt: date })).toMatchObject({ sequence: BigInt(1) })
  })

  it("fails closed for malformed JSON projections", () => {
    expect(() => mapItem({ id: "i", sessionId: "s", turnId: "t", stepId: null, taskId: null, type: "agent_message", status: "started", phase: null, revision: 0, content: new Date(), startedAt: null, completedAt: null, createdAt: date, updatedAt: date })).toThrow("invalid JSON")
  })
})
