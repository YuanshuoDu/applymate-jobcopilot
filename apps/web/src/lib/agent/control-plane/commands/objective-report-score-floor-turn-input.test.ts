import { describe, expect, it } from "vitest"
import { OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT } from "@jobcopilot/agent-protocol"

import { objectiveReportScoreFloorTurnInput } from "./objective-report-score-floor-turn-input"

const command = { userId: "user_1", sessionId: "session_1", clientMessageId: "command_1", source: "user" as const }
const requirements = {
  schemaVersion: "agent-harness.v2.objective-requirements.v1",
  requirements: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 2 } }],
} as const

describe("Objective report score floor Turn input", () => {
  it("preserves omitted and null requirements while adding only an explicit floor", () => {
    expect(objectiveReportScoreFloorTurnInput(command, OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, undefined)).toEqual({})
    expect(objectiveReportScoreFloorTurnInput(
      { ...command, reportScoreFloor: 0 }, OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, null,
    )).toEqual({ verificationRequirements: null, reportScoreFloor: 0 })
    expect(objectiveReportScoreFloorTurnInput(
      { ...command, reportScoreFloor: 10 }, OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, requirements,
    )).toEqual({ verificationRequirements: requirements, reportScoreFloor: 10 })
  })

  it("rejects invalid floors and non-Objective authority", () => {
    for (const reportScoreFloor of [null, -1, 10.1, "8", Number.NaN]) {
      expect(() => objectiveReportScoreFloorTurnInput(
        { ...command, reportScoreFloor }, OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, undefined,
      )).toThrow("objective_report_score_floor_binding_invalid")
    }
    expect(() => objectiveReportScoreFloorTurnInput(
      { ...command, reportScoreFloor: 5 }, undefined, undefined,
    )).toThrow("objective_report_score_floor_binding_invalid")
    expect(() => objectiveReportScoreFloorTurnInput(
      { ...command, source: "automation", reportScoreFloor: 5 },
      OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, undefined,
    )).toThrow("objective_report_score_floor_binding_invalid")
  })
})