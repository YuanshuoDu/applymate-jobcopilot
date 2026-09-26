import { describe, expect, it } from "vitest"
import type { ClaimedInputs, StepCheckpoint, StoredAgentInput } from "./input-claim-types.js"

describe("input claim transaction types", () => {
  it("retain the bounded checkpoint and claim shape", () => {
    const checkpoint: StepCheckpoint = { inputThroughSequence: 2n, consumedInputIds: ["input-1"] }
    const claimed: ClaimedInputs = { inputs: [], newlyClaimedInputIds: [] }
    const input: Pick<StoredAgentInput, "id" | "acceptedSequence"> = { id: "input-1", acceptedSequence: 2n }
    expect({ checkpoint, claimed, input }).toEqual({ checkpoint, claimed, input })
  })
})
