import { describe, expect, it } from "vitest"
import { isObjectiveTailorWaveBudgetSnapshot, objectiveTailorWaveBudgetDisposition,
  OBJECTIVE_TAILOR_WAVE_BUDGET_PROFILE } from "./objective-tailor-wave-profile.js"

const profile = { limits: { maxSteps: 96 }, objectiveTailorProfile: OBJECTIVE_TAILOR_WAVE_BUDGET_PROFILE }

describe("Objective Tailor wave budget profile", () => {
  it("recognizes only the exact server-owned profile snapshot", () => {
    expect(objectiveTailorWaveBudgetDisposition(profile)).toBe("wave")
    expect(isObjectiveTailorWaveBudgetSnapshot(profile)).toBe(true)
    expect(objectiveTailorWaveBudgetDisposition({})).toBe("legacy")
    expect(objectiveTailorWaveBudgetDisposition({ limits: { maxSteps: 32 } })).toBe("legacy")
    expect(objectiveTailorWaveBudgetDisposition(undefined)).toBe("legacy")
    expect(objectiveTailorWaveBudgetDisposition(null)).toBe("legacy")
  })

  it("blocks malformed, unsupported, and accessor-backed profile claims from falling back to legacy", () => {
    for (const value of [
      { ...profile, limits: { maxSteps: 32 } },
      { ...profile, objectiveTailorProfile: "agent-harness.v2.objective-tailor-execution-budget.v2" },
      { ...profile, unexpected: true },
      { limits: { maxSteps: 96 }, get objectiveTailorProfile() { return OBJECTIVE_TAILOR_WAVE_BUDGET_PROFILE } },
    ]) {
      expect(objectiveTailorWaveBudgetDisposition(value)).toBe("invalid")
      expect(isObjectiveTailorWaveBudgetSnapshot(value)).toBe(false)
    }
  })
})
