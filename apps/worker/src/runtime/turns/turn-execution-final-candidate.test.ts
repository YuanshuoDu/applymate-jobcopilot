import { describe, expect, it } from "vitest"
import { persistedFinalCandidate } from "./turn-execution-final-candidate.js"

describe("persistedFinalCandidate", () => {
  it("returns only the exact content agreed by the durable item and serialized response", () => {
    const final = { schemaVersion: "agent-harness.v2.final", response: "actual final" }
    expect(persistedFinalCandidate({ text: "actual final", final }, JSON.stringify(final))).toBe("actual final")
  })

  it("rejects a swapped item body or serialized response", () => {
    const final = { schemaVersion: "agent-harness.v2.final", response: "accepted candidate" }
    expect(persistedFinalCandidate({ text: "swapped candidate", final }, JSON.stringify(final))).toBeNull()
    expect(persistedFinalCandidate({ text: "accepted candidate", final }, JSON.stringify({ ...final, response: "swapped candidate" }))).toBeNull()
  })
})
