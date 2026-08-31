import { describe, expect, it, vi } from "vitest"

import { compareTranscriptGolden, legacyTranscriptData, projectV2EventToTranscript, projectV2EventsToTranscript, transcriptProjectionMarker } from "./transcript-projector"

const baseEvent = {
  id: "event_1",
  sessionId: "session_1",
  turnId: "turn_1",
  itemId: "item_1",
  taskId: null,
  actor: "orchestrator" as const,
  type: "item.completed",
  payload: {
    legacy: {
      type: "orchestrator_plan",
      speaker: "Orchestrator",
      title: "Plan",
      body: "Scout jobs",
      data: { plan: "Scout jobs" },
    },
  },
}

const goldenCases = [
  { flow: "chat", legacy: { type: "user_message", speaker: "You", title: "Message", body: "Find Berlin jobs", data: null } },
  { flow: "run", legacy: { type: "job_results", speaker: "Analyst", title: "Jobs", body: "N26", data: { jobs: [{ id: "job_1" }] } } },
  { flow: "automation", legacy: { type: "automation_started", speaker: "Orchestrator", title: "Started", body: "Morning run", data: { automationId: "automation_1" } } },
] as const

describe("V2 transcript projector", () => {
  it("reconstructs a legacy transcript row and adds a non-display marker", () => {
    const projected = projectV2EventToTranscript(baseEvent)

    expect(projected).toMatchObject({
      sessionId: "session_1",
      taskId: null,
      type: "orchestrator_plan",
      speaker: "Orchestrator",
      title: "Plan",
      body: "Scout jobs",
      data: { plan: "Scout jobs" },
    })
    expect(transcriptProjectionMarker(projected.data)).toEqual({ eventId: "event_1", opaque: false, wrapped: false })
  })

  it("does not discard an event whose legacy payload is absent", () => {
    const projected = projectV2EventToTranscript({ ...baseEvent, id: "event_2", type: "legacy.opaque", payload: { sourcePayload: { future: true } } })

    expect(projected).toMatchObject({ type: "error", speaker: "System", body: "Preserved an unrecognized agent event: legacy.opaque" })
    expect(projected.data).toMatchObject({ opaque: true, eventType: "legacy.opaque", payload: { future: true } })
    expect(transcriptProjectionMarker(projected.data)).toEqual({ eventId: "event_2", opaque: true, wrapped: false })
  })

  it.each(goldenCases)("keeps $flow golden transcript semantics stable", ({ flow, legacy }) => {
    const projected = projectV2EventToTranscript({
      ...baseEvent,
      id: `event-${flow}`,
      payload: { legacy },
    })

    expect(compareTranscriptGolden(legacy, projected)).toEqual({ matches: true, differences: [] })
  })

  it("restores scalar data without confusing an original legacyValue object", () => {
    const scalar = projectV2EventToTranscript({ ...baseEvent, id: "event-scalar", payload: { legacy: { ...goldenCases[0].legacy, data: "ok" } } })
    const object = projectV2EventToTranscript({ ...baseEvent, id: "event-object", payload: { legacy: { ...goldenCases[0].legacy, data: { legacyValue: "kept" } } } })

    expect(legacyTranscriptData(scalar.data)).toBe("ok")
    expect(legacyTranscriptData(object.data)).toEqual({ legacyValue: "kept" })
  })

  it("rebuilds only missing transcript rows under the session transaction", async () => {
    const event = {
      ...baseEvent,
      payload: { legacy: { type: "job_results", speaker: "Analyst", title: "Jobs", body: "N26", data: { jobs: 1 } } },
    }
    const transcriptCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ data }))
    const transcriptFindMany = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ data: (await projectV2EventToTranscript(event)).data }])
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "session_1" }]),
      agentEvent: { findMany: vi.fn().mockResolvedValue([event]) },
      agentTranscriptEvent: { findMany: transcriptFindMany, create: transcriptCreate },
    }
    const db = { $transaction: vi.fn(async <T>(work: (transaction: typeof tx) => Promise<T>) => work(tx)) }

    await expect(projectV2EventsToTranscript(db as never, { sessionId: "session_1", userId: "user_1" })).resolves.toBe(1)
    await expect(projectV2EventsToTranscript(db as never, { sessionId: "session_1", userId: "user_1" })).resolves.toBe(0)
    expect(transcriptCreate).toHaveBeenCalledOnce()
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2)
  })
})
