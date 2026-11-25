/** Parses the optional user-selected Objective report threshold without assigning a default. */
export function parseObjectiveReportScoreFloor(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10
    ? value
    : null
}
