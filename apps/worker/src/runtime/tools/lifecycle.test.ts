import { ToolCallItemSchema, ToolResultItemSchema, validate } from "@jobcopilot/agent-protocol"
import { describe, expect, it, vi } from "vitest"

import type { ExecutionOwner } from "../execution-owner.js"
import { InMemoryToolLifecycleSink, ToolLifecycle, type LifecycleCall } from "./lifecycle.js"
import { InMemoryToolResultReferenceStore, prepareLifecycleValue } from "./redaction.js"
import type { ToolResultReferenceRepository } from "./tool-result-reference-types.js"

const call: LifecycleCall = { id: "call-1", toolName: "jobs.search", toolVersion: "1", sessionId: "session-1", turnId: "turn-1", stepId: "step-1" }
const planCall: LifecycleCall = { ...call, toolName: "agent.plan" }
const planReceipt = {
  status: "accepted",
  revision: 1,
  nodes: [
    { key: "source / résumé:💼", taskId: "subagent-12345678-1234-4abc-8def-123456789012", status: "queued" },
    { key: "dependent-b", taskId: "subagent-87654321-4321-4abc-8def-210987654321", status: "waiting" },
  ],
  readyTaskIds: ["subagent-12345678-1234-4abc-8def-123456789012"],
} as const
const spawnTurnId = "c123456789012345678901234"
const spawnRootTaskId = `root-${spawnTurnId}`
const spawnTaskId = "subagent-0e34de21-c5e7-4db7-8e75-904732813337"
const spawnCall: LifecycleCall = {
  ...call, id: "call-spawn", toolName: "agent.spawn", turnId: spawnTurnId,
  taskId: spawnRootTaskId, rootTaskId: spawnRootTaskId,
}
const spawnReceipt = {
  taskId: spawnTaskId, rootTaskId: spawnRootTaskId, parentTaskId: spawnRootTaskId,
  path: `/${spawnRootTaskId}/${spawnTaskId}`, depth: 1, status: "queued", replay: false,
} as const
const durableWaitReceipt = {
  waitId: "wait-12345678-1234-4234-9234-123456789012",
  status: "ready",
  taskIds: [spawnTaskId],
  deadlineAt: "2026-09-29T12:00:00.000Z",
  matchedTaskIds: [spawnTaskId],
  tasks: [{ taskId: spawnTaskId, result: { email: "candidate@example.com" } }],
}
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

  it("preserves bounded TaskGraph IDs and valid punctuation/Unicode keys in the receipt and lifecycle event", async () => {
    const sink = new InMemoryToolLifecycleSink()
    const lifecycle = new ToolLifecycle({ sink })
    expect(prepareLifecycleValue(planReceipt).safe).not.toEqual(planReceipt)

    const output = await lifecycle.completed(planCall, planReceipt)

    expect(output).toEqual(planReceipt)
    expect(sink.events).toHaveLength(1)
    expect(sink.events[0]?.item).toMatchObject({ type: "tool_result", output: planReceipt })
    expect(sink.events[0]?.payload.output).toEqual(planReceipt)
  })

  it("returns phone-like generated spawn IDs intact for the following agent.wait call", async () => {
    const sink = new InMemoryToolLifecycleSink()
    const lifecycle = new ToolLifecycle({ sink })
    expect(prepareLifecycleValue(spawnReceipt).safe).not.toEqual(spawnReceipt)

    const output = await lifecycle.completed(spawnCall, spawnReceipt) as typeof spawnReceipt
    const followingWaitInput = { taskIds: [output.taskId] }

    expect(output).toEqual(spawnReceipt)
    expect(followingWaitInput).toEqual({ taskIds: [spawnTaskId] })
    expect(sink.events[0]?.item).toMatchObject({ type: "tool_result", output: spawnReceipt })
    expect(sink.events[0]?.payload.output).toEqual(spawnReceipt)
  })

  it("preserves the legacy spawn_subagent alias through lifecycle redaction", async () => {
    const lifecycle = new ToolLifecycle({ sink: new InMemoryToolLifecycleSink() })
    const output = await lifecycle.completed({ ...spawnCall, id: "call-spawn-alias", toolName: "spawn_subagent" }, spawnReceipt)
    expect(output).toEqual(spawnReceipt)
  })

  it.each(["agent.wait", "wait_subagents"])("preserves a generated wait ID and redacts other fields for %s", async toolName => {
    const sink = new InMemoryToolLifecycleSink()
    const lifecycle = new ToolLifecycle({ sink })
    const output = await lifecycle.completed({ ...call, id: `call-${toolName}`, toolName }, {
      ...durableWaitReceipt,
      detail: "Contact candidate@example.com at 202-555-0199",
    })

    expect(output).toMatchObject({
      waitId: durableWaitReceipt.waitId,
      status: "ready",
      detail: "Contact [REDACTED_EMAIL] at [REDACTED_PHONE]",
      tasks: [{ result: { email: "[REDACTED]" } }],
    })
    expect(sink.events[0]?.item).toMatchObject({ type: "tool_result", output })
    expect(sink.events[0]?.payload.output).toEqual(output)
  })

  it.each(["agent.wait", "wait_subagents"])("redacts malformed wait IDs for %s", async toolName => {
    const sink = new InMemoryToolLifecycleSink()
    const lifecycle = new ToolLifecycle({ sink })
    const output = await lifecycle.completed({ ...call, id: `call-${toolName}-malformed`, toolName }, {
      waitId: "wait-123",
      status: "ready",
      email: "candidate@example.com",
    })

    expect(output).toEqual({ waitId: "[REDACTED]", status: "ready", email: "[REDACTED]" })
    expect(sink.events[0]?.payload.output).toEqual(output)
  })

  it("keeps generic redaction for canonical wait-shaped IDs on unrelated tools", async () => {
    const lifecycle = new ToolLifecycle({ sink: new InMemoryToolLifecycleSink() })
    const output = await lifecycle.completed(call, { waitId: durableWaitReceipt.waitId })
    expect(output).toEqual({ waitId: "wait-[REDACTED_PHONE]" })
  })

  it("fails closed for malformed or extra-field agent.spawn receipts", async () => {
    const sink = new InMemoryToolLifecycleSink()
    const lifecycle = new ToolLifecycle({ sink })

    await expect(lifecycle.completed(spawnCall, { ...spawnReceipt, email: "candidate@example.com" })).rejects.toMatchObject({
      code: "subagent_spawn_receipt_invalid",
    })
    expect(sink.events).toHaveLength(0)
  })

  it("keeps generic phone and email redaction and rejects malformed TaskGraph receipts", async () => {
    const ordinarySink = new InMemoryToolLifecycleSink()
    const ordinaryLifecycle = new ToolLifecycle({ sink: ordinarySink })
    const ordinary = await ordinaryLifecycle.completed(call, {
      message: "Email candidate@example.com or call 202-555-0199",
    })
    expect(ordinary).toEqual({ message: "Email [REDACTED_EMAIL] or call [REDACTED_PHONE]" })

    const malformedReceipts = [
      { ...planReceipt, extra: "candidate@example.com" },
      { ...planReceipt, nodes: [{ ...planReceipt.nodes[0], extra: "202-555-0199" }, planReceipt.nodes[1]] },
      { ...planReceipt, readyTaskIds: ["subagent-00000000-0000-4000-8000-000000000000"] },
      { ...planReceipt, nodes: [{ ...planReceipt.nodes[0], key: "candidate@example.com" }, planReceipt.nodes[1]] },
      { ...planReceipt, nodes: [{ ...planReceipt.nodes[0], key: "+1 (415) 555-0132" }, planReceipt.nodes[1]] },
      { ...planReceipt, nodes: [{ ...planReceipt.nodes[0], key: "password=private-token-value" }, planReceipt.nodes[1]] },
    ]
    for (const receipt of malformedReceipts) {
      const sink = new InMemoryToolLifecycleSink()
      const lifecycle = new ToolLifecycle({ sink })
      await expect(lifecycle.completed(planCall, receipt)).rejects.toMatchObject({ code: "task_graph_receipt_invalid" })
      expect(sink.events).toHaveLength(0)
    }
  })
})
