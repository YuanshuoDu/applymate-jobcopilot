import { describe, expect, it } from "vitest"
import { OBJECTIVE_TAILOR_GRAPH_SCORE_FLOOR_SCHEMA_VERSION, OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { buildObjectiveTailorGraphMarker, objectiveTailorGraphFloorMatchesTurn,
  readObjectiveTailorScoreFloorRequest } from "./objective-tailor-score-floor-marker.js"

const slots = [{ slotId: "tailor-1", sourceAnalystNodeKey: "analyst-1", writerNodeKey: "writer-1", reviewerNodeKey: "reviewer-1" }] as never
const nodes = [
  { key: "scout-1", templateId: "scout", verificationDisposition: "typed", dependsOn: [] },
  { key: "analyst-1", templateId: "analyst", verificationDisposition: "typed", dependsOn: ["scout-1"] },
  { key: "writer-1", templateId: "cover_letter_writer", dependsOn: ["analyst-1"] },
  { key: "reviewer-1", templateId: "cover_letter_reviewer", dependsOn: ["writer-1"] },
]

describe("Objective Tailor requested score floor marker", () => {
  it("copies an own valid Turn value into V2 and keeps omission at V1", () => {
    const request = { intent: {}, reportScoreFloor: 0 }
    expect(readObjectiveTailorScoreFloorRequest(request)).toEqual({ status: "requested", value: 0 })
    expect(buildObjectiveTailorGraphMarker(2, slots, readObjectiveTailorScoreFloorRequest(request))).toEqual({
      schemaVersion: OBJECTIVE_TAILOR_GRAPH_SCORE_FLOOR_SCHEMA_VERSION, sourceNodeCount: 2,
      reportScoreFloor: 0, slots,
    })
    expect(buildObjectiveTailorGraphMarker(2, slots, readObjectiveTailorScoreFloorRequest({ intent: {} }))).toEqual({
      schemaVersion: OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION, sourceNodeCount: 2, slots,
    })
  })

  it("rejects malformed own fields and accessors without treating them as omission", () => {
    for (const value of [NaN, Infinity, -0.1, 10.1, "8", null]) {
      expect(readObjectiveTailorScoreFloorRequest({ reportScoreFloor: value }).status).toBe("invalid")
    }
    const accessor = Object.defineProperty({}, "reportScoreFloor", { enumerable: true, get: () => 8 })
    expect(readObjectiveTailorScoreFloorRequest(accessor).status).toBe("invalid")
  })

  it("requires exact persisted Turn/marker equality while allowing an unmarked first wave", () => {
    const input = { intent: {}, reportScoreFloor: 8 }
    const marker = { schemaVersion: OBJECTIVE_TAILOR_GRAPH_SCORE_FLOOR_SCHEMA_VERSION,
      sourceNodeCount: 2, reportScoreFloor: 8, slots }
    expect(objectiveTailorGraphFloorMatchesTurn(undefined, nodes, input)).toBe(true)
    expect(objectiveTailorGraphFloorMatchesTurn(marker, nodes, input)).toBe(true)
    expect(objectiveTailorGraphFloorMatchesTurn({ ...marker, reportScoreFloor: 9 }, nodes, input)).toBe(false)
    expect(objectiveTailorGraphFloorMatchesTurn({ ...marker, schemaVersion: OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION,
      reportScoreFloor: undefined }, nodes, input)).toBe(false)
    expect(objectiveTailorGraphFloorMatchesTurn({ schemaVersion: OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION,
      sourceNodeCount: 2, slots }, nodes, { intent: {} })).toBe(true)
    expect(objectiveTailorGraphFloorMatchesTurn(marker, nodes, { intent: {} })).toBe(false)
  })
})
