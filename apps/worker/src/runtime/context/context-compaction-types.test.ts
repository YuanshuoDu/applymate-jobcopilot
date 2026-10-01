import { describe, expect, it } from "vitest"

import { COMPACTION_ITEM_TYPE, CompactionError } from "./context-compaction-types.js"
import type { CompactionRequest } from "./context-compaction-types.js"

describe("context compaction contracts", () => {
  it("uses the protocol's generic compaction item type", () => {
    expect(COMPACTION_ITEM_TYPE).toBe("context_compaction")
  })

  it("does not accept a caller-chosen snapshot version", () => {
    const request: CompactionRequest = {
      scope: { userId: "user-a" }, turnId: "turn-a",
      source: { state: { ownerId: "user-a", sessionId: "session-a", throughSequence: 0n, goal: "Goal", userConstraints: [], approvals: [], answers: [], artifacts: [], openTasks: [], doNotRepeat: [], facts: [] }, items: [] },
      policy: { inputTokenThreshold: 10, itemCountThreshold: 10, compactAtTurnBoundary: true }, atTurnBoundary: false, requested: false,
    }
    expect("version" in request).toBe(false)
  })

  it("exposes a typed failure without exposing source content", () => {
    const error = new CompactionError("invariant_loss", "Compaction invariant comparison failed")
    expect(error).toMatchObject({ name: "CompactionError", code: "invariant_loss" })
    expect(error.message).not.toContain("answer")
  })
})
