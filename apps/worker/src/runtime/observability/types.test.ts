import { describe, expect, it } from "vitest"

import { HARNESS_EVENT_TYPES, makeSafeMetricPayload, ObservabilityValidationError } from "./types.js"

describe("Worker observability types", () => {
  it("keeps the Worker taxonomy exactly aligned with AH2-050", () => {
    expect(HARNESS_EVENT_TYPES).toEqual([
      "session.started", "session.completed", "turn.queued", "turn.started", "turn.completed", "turn.failed", "turn.recovered",
      "tool.invoked", "tool.completed", "tool.failed", "approval.requested", "approval.granted", "approval.denied", "approval.expired",
      "artifact.created", "artifact.updated", "submission.attempted", "submission.completed", "submission.failed", "cost.charged", "queue.depth",
    ])
  })

  it("accepts bounded operational metadata and returns a detached payload", () => {
    const input = { status: "completed", durationMs: 2 }
    const payload = makeSafeMetricPayload(input)
    expect(payload).toEqual(input)
    expect(payload).not.toBe(input)
  })

  it.each([
    { email: "candidate@example.com" },
    { text: "raw application text" },
    { clientIp: "192.0.2.10" },
    { prompt: "user prompt" },
  ])("rejects PII-bearing key $%s", (payload) => {
    expect(() => makeSafeMetricPayload(payload)).toThrow(ObservabilityValidationError)
  })

  it("rejects non-JSON values instead of silently dropping them", () => {
    expect(() => makeSafeMetricPayload({ value: undefined })).toThrow(ObservabilityValidationError)
    expect(() => makeSafeMetricPayload({ value: Number.NaN })).toThrow(ObservabilityValidationError)
  })
})
