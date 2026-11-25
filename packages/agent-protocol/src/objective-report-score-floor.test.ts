import { describe, expect, it } from "vitest"
import { parseObjectiveReportScoreFloor } from "./objective-report-score-floor.js"

describe("parseObjectiveReportScoreFloor", () => {
  it("accepts explicit inclusive numeric bounds and decimals", () => {
    expect(parseObjectiveReportScoreFloor(0)).toBe(0)
    expect(parseObjectiveReportScoreFloor(4.5)).toBe(4.5)
    expect(parseObjectiveReportScoreFloor(10)).toBe(10)
  })

  it("rejects absent-like, nonnumeric, nonfinite, and out-of-range values", () => {
    for (const value of [undefined, null, "8", Number.NaN, Infinity, -0.01, 10.01, true, {}, []]) {
      expect(parseObjectiveReportScoreFloor(value)).toBeNull()
    }
  })
})
