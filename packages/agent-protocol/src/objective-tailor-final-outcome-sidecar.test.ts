import { describe, expect, it } from "vitest"
import { OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_SCHEMA, parseObjectiveTailorFinalOutcomeSidecar } from "./objective-tailor-final-outcome-sidecar.js"

const valid = { schemaVersion: OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_SCHEMA,
  slots: [{ ordinal: 1, status: "ready" }, { ordinal: 2, status: "needs_revision" }] }

describe("parseObjectiveTailorFinalOutcomeSidecar", () => {
  it("keeps only dense one-based slot ordinal and settled status", () => {
    expect(parseObjectiveTailorFinalOutcomeSidecar(valid)).toEqual(valid)
  })

  it("rejects malformed, private, or nonterminal fields", () => {
    const extra = { ...valid, graphDigest: "private" }
    const privateSlot = { schemaVersion: valid.schemaVersion, slots: [{ ...valid.slots[0], taskId: "private-task" }] }
    const accessor = { schemaVersion: valid.schemaVersion, slots: [{ ordinal: 1, get status() { throw new Error("must not run") } }] }
    const duplicateOrdinal = { schemaVersion: valid.schemaVersion, slots: [{ ordinal: 1, status: "ready" }, { ordinal: 1, status: "failed" }] }
    const unsupported = { schemaVersion: valid.schemaVersion, slots: [{ ordinal: 1, status: "pending" }] }
    const sparse = { schemaVersion: valid.schemaVersion, slots: Array(1) }
    for (const value of [extra, privateSlot, accessor, duplicateOrdinal, unsupported, sparse, { ...valid, unknown: true }]) {
      expect(parseObjectiveTailorFinalOutcomeSidecar(value)).toBeUndefined()
    }
  })

  it("rejects root accessors, symbols, and more than eight slots", () => {
    const accessor = Object.defineProperty({ slots: valid.slots }, "schemaVersion", { enumerable: true, get: () => valid.schemaVersion })
    const symbol = { ...valid, [Symbol("extra")]: true }
    const tooMany = { schemaVersion: valid.schemaVersion, slots: Array.from({ length: 9 }, (_, index) => ({ ordinal: index + 1, status: "ready" })) }
    for (const value of [accessor, symbol, tooMany]) expect(parseObjectiveTailorFinalOutcomeSidecar(value)).toBeUndefined()
  })
})
