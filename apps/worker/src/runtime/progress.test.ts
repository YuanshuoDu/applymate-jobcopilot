import { describe, expect, it } from "vitest"

import { createProgressDetector, NoProgressError } from "./progress.js"

const snapshot = { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] }

describe("no-progress detector", () => {
  it("stops a repeated tool signature with a reason code", () => {
    const detector = createProgressDetector(2)
    const calls = [{ id: "call-1", name: "jobs.search", arguments: { location: "Dublin" } }]
    detector.observe({ snapshot, toolCalls: calls })
    expect(() => detector.observe({ snapshot, toolCalls: [{ ...calls[0], id: "call-2" }] })).toThrowError(NoProgressError)
    try { detector.observe({ snapshot, toolCalls: calls }) } catch (error: unknown) { expect(error).toMatchObject({ code: "no_progress", reasonCode: "repeated_signature" }) }
  })
})
