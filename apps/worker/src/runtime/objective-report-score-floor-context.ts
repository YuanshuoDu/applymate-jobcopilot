import { parseObjectiveReportScoreFloor } from "@jobcopilot/agent-protocol"

export const OBJECTIVE_REPORT_SCORE_FLOOR_OBSERVATION_ID = "objective-report-score-floor"
const SCHEMA_VERSION = "agent-harness.v2.objective-report-score-floor-context.v1"

type ScoreFloorObservation = Readonly<{
  id: typeof OBJECTIVE_REPORT_SCORE_FLOOR_OBSERVATION_ID
  content: Readonly<{
    schemaVersion: typeof SCHEMA_VERSION
    kind: "objective_report_score_floor"
    status: "requested" | "unavailable"
    reportingOnly: true
    notVerificationCriterion: true
    reportScoreFloor?: number
  }>
}>

export function objectiveReportScoreFloorObservation(turnInput: unknown): ScoreFloorObservation | undefined {
  if (!turnInput || typeof turnInput !== "object" || Array.isArray(turnInput)) return undefined
  let descriptor: PropertyDescriptor | undefined
  try { descriptor = Object.getOwnPropertyDescriptor(turnInput, "reportScoreFloor") } catch { return undefined }
  if (!descriptor) return undefined
  const floor = "value" in descriptor && descriptor.enumerable
    ? parseObjectiveReportScoreFloor(descriptor.value) : null
  return {
    id: OBJECTIVE_REPORT_SCORE_FLOOR_OBSERVATION_ID,
    content: {
      schemaVersion: SCHEMA_VERSION,
      kind: "objective_report_score_floor",
      status: floor === null ? "unavailable" : "requested",
      reportingOnly: true,
      notVerificationCriterion: true,
      ...(floor === null ? {} : { reportScoreFloor: floor }),
    },
  }
}