import {
  OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION,
  OBJECTIVE_TAILOR_GRAPH_SCORE_FLOOR_SCHEMA_VERSION,
  parseObjectiveReportScoreFloor,
  parseObjectiveTailorGraph,
  type ObjectiveTailorGraph,
} from "@jobcopilot/agent-protocol"

export type ObjectiveTailorScoreFloorRequest = Readonly<{ status: "not_requested" }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "requested"; value: number }>

export function readObjectiveTailorScoreFloorRequest(input: unknown): ObjectiveTailorScoreFloorRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { status: "invalid" }
  try {
    const prototype = Object.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null || Reflect.ownKeys(input).some(key => typeof key !== "string")) return { status: "invalid" }
  } catch { return { status: "invalid" } }
  let descriptor: PropertyDescriptor | undefined
  try { descriptor = Object.getOwnPropertyDescriptor(input, "reportScoreFloor") } catch { return { status: "invalid" } }
  if (!descriptor) return { status: "not_requested" }
  if (!descriptor.enumerable || !("value" in descriptor)) return { status: "invalid" }
  const value = parseObjectiveReportScoreFloor(descriptor.value)
  return value === null ? { status: "invalid" } : { status: "requested", value }
}

export function objectiveTailorGraphFloorMatchesTurn(marker: unknown, nodes: unknown, input: unknown): boolean {
  const request = readObjectiveTailorScoreFloorRequest(input)
  if (request.status === "invalid") return false
  if (marker === undefined || marker === null) return true
  const graph = parseObjectiveTailorGraph(marker, nodes)
  return Boolean(graph && (request.status === "not_requested"
    ? graph.schemaVersion === OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION
    : graph.schemaVersion === OBJECTIVE_TAILOR_GRAPH_SCORE_FLOOR_SCHEMA_VERSION
      && graph.reportScoreFloor === request.value))
}

export function buildObjectiveTailorGraphMarker(
  sourceNodeCount: number, slots: ObjectiveTailorGraph["slots"], request: ObjectiveTailorScoreFloorRequest,
): ObjectiveTailorGraph | undefined {
  if (request.status === "invalid") return undefined
  return request.status === "requested"
    ? { schemaVersion: OBJECTIVE_TAILOR_GRAPH_SCORE_FLOOR_SCHEMA_VERSION, sourceNodeCount,
      reportScoreFloor: request.value, slots }
    : { schemaVersion: OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION, sourceNodeCount, slots }
}
