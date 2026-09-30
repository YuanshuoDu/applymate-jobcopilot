import { ToolCallItemSchema, ToolResultItemSchema, validate } from "@jobcopilot/agent-protocol"
import { describe, expect, it, vi } from "vitest"

import type { ExecutionOwner } from "../execution-owner.js"
import { InMemoryToolLifecycleSink, ToolLifecycle, type LifecycleCall } from "./lifecycle.js"
import { InMemoryToolResultReferenceStore } from "./redaction.js"
import type { ToolResultReferenceRepository } from "./tool-result-reference-types.js"

const call: LifecycleCall = { id: "call-1", toolName: "jobs.search", toolVersion: "1", sessionId: "session-1", turnId: "turn-1", stepId: "step-1" }
const owner: ExecutionOwner = {
  kind: "turn", taskId: "root-1", lease: {
    turnId: "turn-1", sessionId: "session-1", ownerId: "worker-1", userId: "user-1", leaseVersion: 1,
    leaseStartedAt: new Date("2026-08-31T11:59:00.000Z"), leaseExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
  },
}

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

  it("persists only oversized completed output with the actual call identity", async () => {
    const sink = new InMemoryToolLifecycleSink()
    const put = vi.fn(async (_owner: ExecutionOwner, input: { stepId: string; toolCallId: string; value: unknown }) => ({
      id: "tool-result-durable", userId: "user-1", sessionId: "session-1", turnId: "turn-1", stepId: input.stepId,
      taskId: "root-1", toolCallId: input.toolCallId, sanitizedJson: input.value as never, sha256: "a".repeat(64),
      byteCount: 9_000, createdAt: new Date(), updatedAt: new Date(),
    }))
    const durableResults = { put, read: vi.fn() } as unknown as ToolResultReferenceRepository
    const lifecycle = new ToolLifecycle({
      sink, durableResults, resolveOwner: () => owner, maxEventBytes: 256,
      now: () => "2026-08-31T12:00:00.000Z",
    })

    await lifecycle.started(call, { query: "x".repeat(9_000) })
    await lifecycle.progress(call, { stage: "x".repeat(9_000) })
    const output = await lifecycle.completed(call, { result: "x".repeat(9_000), password: "secret" })

    expect(output).toEqual({ $ref: "tool-result-durable", sizeBytes: 9_000, sha256: "a".repeat(64) })
    expect(put).toHaveBeenCalledWith(owner, expect.objectContaining({ stepId: "step-1", toolCallId: "call-1" }))
    expect(sink.events[0]?.item).toMatchObject({ input: { $truncated: true } })
    expect(sink.events[1]?.payload).toMatchObject({ progress: { $truncated: true } })
    expect(JSON.stringify(sink.events)).not.toContain("secret")
  })

  it("fails closed when oversized output has no durable owner binding", async () => {
    const lifecycle = new ToolLifecycle({ sink: new InMemoryToolLifecycleSink(), maxEventBytes: 256 })
    await expect(lifecycle.completed(call, { result: "x".repeat(9_000) })).rejects.toMatchObject({
      code: "tool_result_storage_unavailable",
    })
  })
})
