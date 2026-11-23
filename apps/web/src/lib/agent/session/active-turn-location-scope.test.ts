import { describe, expect, it } from "vitest"
import { projectActiveTurnLocationScope } from "./active-turn-location-scope"
import type { ActiveTurnLocationAcceptance } from "./active-turn-location-acceptance"

function confirmation(inputId: string, locations: readonly string[]): ActiveTurnLocationAcceptance {
  return { inputId, acceptedInputSequence: BigInt(inputId.endsWith("2") ? 8 : 4), receiptSequence: BigInt(inputId.endsWith("2") ? 9 : 5),
    locations, consumed: true, consumedByStepId: `step-${inputId}` }
}

describe("active Turn location scope projection", () => {
  it("keeps an accepted confirmation pending until its persisted plan proof arrives", () => {
    expect(projectActiveTurnLocationScope([confirmation("input-1", ["dublin"])], new Map())).toEqual({
      confirmed: { locations: ["dublin"], status: "pending" },
    })
  })

  it("shows the applied locations only after a verified accepted proposal", () => {
    expect(projectActiveTurnLocationScope([confirmation("input-1", ["dublin"])], new Map([["input-1", "revise"]]))).toEqual({
      confirmed: { locations: ["dublin"], status: "adopted" }, appliedLocations: ["dublin"],
    })
  })

  it("preserves the prior applied scope while the newest confirmation is pending", () => {
    expect(projectActiveTurnLocationScope([
      confirmation("input-1", ["berlin"]), confirmation("input-2", ["dublin"]),
    ], new Map([["input-1", "revise"]]))).toEqual({
      confirmed: { locations: ["dublin"], status: "pending" }, appliedLocations: ["berlin"],
    })
  })

  it("adopts an exact keep only when the same scope was already proven applied", () => {
    expect(projectActiveTurnLocationScope([
      confirmation("input-1", ["dublin"]), confirmation("input-2", ["dublin"]),
    ], new Map([["input-1", "revise"], ["input-2", "keep"]]))).toEqual({
      confirmed: { locations: ["dublin"], status: "adopted" }, appliedLocations: ["dublin"],
    })
    expect(projectActiveTurnLocationScope([
      confirmation("input-1", ["berlin"]), confirmation("input-2", ["dublin"]),
    ], new Map([["input-2", "keep"]]))).toEqual({
      confirmed: { locations: ["dublin"], status: "pending" },
    })
  })

  it("ignores foreign proof identities and does not project an older Turn as latest", () => {
    const rows = [confirmation("input-1", ["berlin"]), confirmation("input-2", ["dublin"])]
    expect(projectActiveTurnLocationScope(rows, new Map([["other-turn-input", "revise"]]))).toEqual({
      confirmed: { locations: ["dublin"], status: "pending" },
    })
    expect(projectActiveTurnLocationScope([], new Map([["input-1", "revise"]]))).toBeNull()
  })
})
