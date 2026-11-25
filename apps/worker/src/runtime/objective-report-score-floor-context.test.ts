import { describe, expect, it } from "vitest"
import {
  OBJECTIVE_REPORT_SCORE_FLOOR_OBSERVATION_ID,
  objectiveReportScoreFloorObservation,
} from "./objective-report-score-floor-context.js"

describe("Objective report score floor observation", () => {
  it("keeps an omitted floor absent and represents explicit boundaries as report-only", () => {
    expect(objectiveReportScoreFloorObservation({ goal: "Find roles" })).toBeUndefined()
    expect(objectiveReportScoreFloorObservation({ reportScoreFloor: 0 })).toEqual({
      id: OBJECTIVE_REPORT_SCORE_FLOOR_OBSERVATION_ID,
      content: {
        schemaVersion: "agent-harness.v2.objective-report-score-floor-context.v1",
        kind: "objective_report_score_floor",
        status: "requested",
        reportingOnly: true,
        notVerificationCriterion: true,
        reportScoreFloor: 0,
      },
    })
    expect(objectiveReportScoreFloorObservation({ reportScoreFloor: 10 })?.content.reportScoreFloor).toBe(10)
  })

  it("does not turn malformed or accessor-backed persisted values into thresholds", () => {
    expect(objectiveReportScoreFloorObservation({ reportScoreFloor: 10.1 })?.content).toEqual({
      schemaVersion: "agent-harness.v2.objective-report-score-floor-context.v1",
      kind: "objective_report_score_floor",
      status: "unavailable",
      reportingOnly: true,
      notVerificationCriterion: true,
    })
    const accessor = Object.defineProperty({}, "reportScoreFloor", { enumerable: true, get: () => 8 })
    expect(objectiveReportScoreFloorObservation(accessor)?.content.status).toBe("unavailable")
  })
})