import { ToolCallItemSchema, ToolResultItemSchema, validate } from "@jobcopilot/agent-protocol"
import { describe, expect, it } from "vitest"

import { InMemoryToolLifecycleSink, ToolLifecycle, type LifecycleCall } from "./lifecycle.js"
import { InMemoryToolResultReferenceStore } from "./redaction.js"

const call: LifecycleCall = { id: "call-1", toolName: "jobs.search", toolVersion: "1", sessionId: "session-1", turnId: "turn-1", stepId: "step-1" }

describe("ToolLifecycle", () => {
  it("emits replayable started, progress, and result Items without raw sensitive data", async () => {
    const sink = new InMemoryToolLifecycleSink()
    const lifecycle = new ToolLifecycle({ sink, references: new InMemoryToolResultReferenceStore(), now: () => "2026-08-31T12:00:00.000Z" })
    await lifecycle.started(call, { query: "Berlin", password: "secret" })
    await lifecycle.progress(call, { stage: "fetching", token: "private" })
    const output = await lifecycle.completed(call, { jobs: [{ id: "job-1" }], email: "candidate@example.com" })

    expect(output).toEqual({ jobs: [{ id: "job-1" }], email: "[REDACTED]" })
    expect(sink.replay().map((event) => event.phase)).toEqual(["started", "progress", "completed"])
    expect(validate(ToolCallItemSchema, sink.events[0].item)).toBe(true)
    expect(validate(ToolCallItemSchema, sink.events[1].item)).toBe(true)
    expect(validate(ToolResultItemSchema, sink.events[2].item)).toBe(true)
    expect(JSON.stringify(sink.events)).not.toContain("secret")
    expect(JSON.stringify(sink.events)).not.toContain("private")
    expect(sink.events[1].item).toMatchObject({ type: "tool_call", input: { query: "Berlin", password: "[REDACTED]" } })
  })

  it("records cancellation as an interrupted result Item", async () => {
    const sink = new InMemoryToolLifecycleSink()
    const lifecycle = new ToolLifecycle({ sink, references: new InMemoryToolResultReferenceStore(), now: () => "2026-08-31T12:00:00.000Z" })
    await lifecycle.started(call, {})
    await lifecycle.failed(call, "cancelled", "cancelled", { reason: "stop" })
    expect(sink.events.at(-1)).toMatchObject({ phase: "cancelled", item: { status: "interrupted", errorCode: "cancelled" } })
  })
})
