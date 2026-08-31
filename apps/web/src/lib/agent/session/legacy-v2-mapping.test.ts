import { describe, expect, it } from "vitest"

import { isKnownPipelineEvent, legacyV2MappingTable, mapLegacyTranscriptToV2 } from "./legacy-v2-mapping"

describe("legacy to Harness 2.0 mapping", () => {
  it("exposes a deterministic mapping table for the legacy transcript vocabulary", () => {
    const table = legacyV2MappingTable()

    expect(table.user_message).toMatchObject({ eventType: "input.accepted", actor: "user", itemType: "user_message" })
    expect(table.approval_request).toMatchObject({ eventType: "approval.requested", itemType: "approval_request" })
    expect(table.final_report).toMatchObject({ eventType: "turn.completed", phase: "final_answer" })
  })

  it("maps pipeline events without losing their source vocabulary", () => {
    expect(isKnownPipelineEvent("agent_reflect")).toBe(true)
    expect(mapLegacyTranscriptToV2({ type: "thinking_summary", speaker: "Analyst" }, "agent_reflect")).toMatchObject({
      eventType: "item.completed",
      actor: "subagent",
      itemType: "reasoning_summary",
      opaque: false,
    })
  })

  it("stores an unknown source event as an opaque fact", () => {
    expect(mapLegacyTranscriptToV2({ type: "error", speaker: "System" }, "future_pipeline_event")).toEqual({
      eventType: "legacy.opaque",
      actor: "system",
      itemType: "artifact",
      itemStatus: "completed",
      phase: "commentary",
      opaque: true,
    })
  })
})
