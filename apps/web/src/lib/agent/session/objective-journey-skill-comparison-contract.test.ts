import { describe, expect, it } from "vitest"
import { OBJECTIVE_JOURNEY_SKILL_COMPARISON_SCHEMA, parseObjectiveJourneySkillComparison } from "./objective-journey-skill-comparison-contract"

const valid = {
  schemaVersion: OBJECTIVE_JOURNEY_SKILL_COMPARISON_SCHEMA, finalItemId: "final-1", graphRevision: 9, coverage: "complete",
  skills: [
    { label: "TypeScript", evidenceStatus: "confirmed_persona_match", slotOrdinals: [1, 2] },
    { label: "Rust", evidenceStatus: "needs_confirmation", slotOrdinals: [1] },
  ], suggestedTerms: ["TypeScript"],
}

describe("objective journey skill comparison contract", () => {
  it("accepts the bounded quote-free projection", () => {
    expect(parseObjectiveJourneySkillComparison(valid)).toEqual(valid)
  })

  it.each([
    ["raw quote", { ...valid, quote: "Must know TypeScript." }],
    ["fact id", { ...valid, factId: "fact-1" }],
    ["unavailable with rows", { ...valid, coverage: "unavailable", skills: [], suggestedTerms: ["TypeScript"] }],
    ["term outside skills", { ...valid, suggestedTerms: ["Python"] }],
    ["needs-confirmation term", { ...valid, suggestedTerms: ["Rust"] }],
    ["normalized-only term", { ...valid, suggestedTerms: ["typescript"] }],
    ["duplicate slot", { ...valid, skills: [{ ...valid.skills[0], slotOrdinals: [1, 1] }, valid.skills[1]] }],
    ["unsorted skill rows", { ...valid, skills: [valid.skills[1], valid.skills[0]] }],
  ] as const)("rejects %s", (_name, value) => {
    expect(parseObjectiveJourneySkillComparison(value)).toBeUndefined()
  })

  it("rejects getter-backed fields and extra nested keys", () => {
    const getter = { ...valid, get coverage() { return "complete" } }
    expect(parseObjectiveJourneySkillComparison(getter)).toBeUndefined()
    expect(parseObjectiveJourneySkillComparison({ ...valid, skills: [{ ...valid.skills[0], extra: true }, valid.skills[1]] })).toBeUndefined()
  })
})
