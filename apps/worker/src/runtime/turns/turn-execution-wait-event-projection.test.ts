import type { AgentEventRecord, RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { describe, expect, it } from "vitest"

import { projectPendingWaitCompletionEvent, projectWaitCallEventContent } from "./turn-execution-wait-event-projection.js"

const targetIds = ["+353 87 123 4567", "subagent-123e4567-e89b-42d3-a456-426614174000"]

function waitCallContent(toolName = "wait_subagents") {
  return {
    toolCallId: "call-1", toolName, toolVersion: "1", status: "completed", errorCode: null,
    input: { idempotencyKey: "opaque-wait-key-001", taskIds: targetIds, mode: "all", timeoutMs: 5_000, goal: "unapproved extra" },
    untrustedExtra: "must be dropped",
  }
}

function event(type: string, payload: RepositoryJsonValue): AgentEventRecord {
  return {
    id: "event-1", sessionId: "session-1", turnId: "turn-1", itemId: "item-1", taskId: "task-1", sequence: 4n,
    type, actor: "subagent", correlationId: "item-1", causationId: "started-1", idempotencyKey: "item-completed-1",
    payload, createdAt: "2026-10-30T00:00:00.000Z",
  }
}

describe("turn execution wait event projection", () => {
  it.each(["wait_subagents", "agent.wait"] as const)("redacts all %s input targets and secrets without changing private source data", toolName => {
    const content = waitCallContent(toolName)
    const projected = projectWaitCallEventContent(content) as Record<string, unknown>
    const input = projected.input as Record<string, unknown>

    expect(input).toMatchObject({
      idempotencyKey: "[REDACTED]",
      taskIds: ["[REDACTED]", "[REDACTED]"],
      mode: "all",
      timeoutMs: 5_000,
    })
    expect(content.input.taskIds).toEqual(targetIds)
    expect(input).not.toHaveProperty("goal")
    expect(projected).not.toHaveProperty("untrustedExtra")
    expect(JSON.stringify(projected)).not.toContain("opaque-wait-key-001")
    expect(JSON.stringify(projected)).not.toContain("subagent-123e4567-e89b-42d3-a456-426614174000")
  })

  it("leaves other tool content byte-for-byte shaped as supplied", () => {
    const content = { toolCallId: "call-2", toolName: "agent.spawn", input: { role: "analyst", taskIds: targetIds } }
    expect(projectWaitCallEventContent(content)).toEqual(content)
  })

  it("projects only wait call item completions, not tool result or unrelated events", () => {
    const callEvent = event("item.completed", { itemId: "item-1", status: "completed", content: waitCallContent(), extra: "drop" })
    const resultEvent = event("item.completed", { itemId: "item-2", status: "completed", content: {
      toolCallId: "call-1", output: { taskIds: targetIds }, errorCode: null,
    } })
    const otherEvent = event("tool_call.completed", { toolCallId: "call-1", toolName: "wait_subagents" })
    const aliasEvent = event("renamed.item.completion", { itemId: "item-1", status: "completed", content: waitCallContent("agent.wait") })

    const safeCall = projectPendingWaitCompletionEvent(callEvent)
    expect(safeCall?.payload).toMatchObject({
      itemId: "item-1", status: "completed", content: { input: { taskIds: ["[REDACTED]", "[REDACTED]"] } },
    })
    expect(safeCall?.payload).not.toHaveProperty("extra")
    expect(projectPendingWaitCompletionEvent(resultEvent)).toBe(resultEvent)
    expect(projectPendingWaitCompletionEvent(otherEvent)).toBe(otherEvent)
    expect(projectPendingWaitCompletionEvent(aliasEvent)?.payload)
      .toMatchObject({ content: { input: { taskIds: ["[REDACTED]", "[REDACTED]"] } } })
    const mismatched = event("renamed.item.completion", { itemId: "other-item", status: "completed", content: waitCallContent("agent.wait") })
    expect(projectPendingWaitCompletionEvent(mismatched)).toBeNull()
    expect(callEvent.payload).toMatchObject({ content: { input: { taskIds: targetIds } } })
  })

  it("redacts malformed target fields instead of forwarding them", () => {
    const content = { ...waitCallContent(), input: { taskIds: { forged: "subagent-123e4567-e89b-42d3-a456-426614174000" } } }
    const projected = projectWaitCallEventContent(content) as Record<string, unknown>
    expect(projected.input).toMatchObject({ taskIds: "[REDACTED]" })
    expect(JSON.stringify(projected)).not.toContain("subagent-123e4567-e89b-42d3-a456-426614174000")
  })

  it.each([
    { label: "negative", timeoutMs: -1 },
    { label: "fractional", timeoutMs: 1.5 },
    { label: "zero", timeoutMs: 0 },
    { label: "too large", timeoutMs: 30_001 },
  ])("omits $label timeout values outside the wait schema", ({ timeoutMs }) => {
    const projected = projectWaitCallEventContent({
      ...waitCallContent(), input: { idempotencyKey: "opaque", taskIds: ["child"], mode: "all", timeoutMs },
    }) as Record<string, unknown>
    expect(projected.input).not.toHaveProperty("timeoutMs")
  })

  it.each([
    { label: "missing", input: undefined },
    { label: "null", input: null },
    { label: "scalar", input: "opaque private input" },
  ])("projects pending wait completions with $label input fail safely", ({ input }) => {
    const content: { toolCallId: string; toolName: string; input?: RepositoryJsonValue } = { toolCallId: "call-1", toolName: "agent.wait" }
    if (input !== undefined) content.input = input
    const projected = projectWaitCallEventContent(content) as Record<string, unknown>
    expect(projected).toMatchObject({ toolName: "agent.wait", input: {} })
    expect(JSON.stringify(projected)).not.toContain("opaque private input")
    const pending = event("renamed.item.completion", { itemId: "item-1", status: "completed", content })
    expect(projectPendingWaitCompletionEvent(pending)?.payload)
      .toMatchObject({ content: { toolName: "agent.wait", input: {} } })
  })

  it("fails closed on malformed wait input and error completions", () => {
    const projected = projectWaitCallEventContent({
      ...waitCallContent("agent.wait"), status: "failed", errorCode: "tool_execution_failed",
      input: { idempotencyKey: "opaque-error-key", taskIds: Array(51).fill("target"), mode: "perhaps", timeoutMs: Number.POSITIVE_INFINITY, goal: "private" },
      leaked: "private",
    }) as Record<string, unknown>
    expect(projected).toMatchObject({
      toolName: "agent.wait", status: "failed", errorCode: "tool_execution_failed",
      input: { idempotencyKey: "[REDACTED]", taskIds: "[REDACTED]" },
    })
    expect(projected).not.toHaveProperty("leaked")
    expect(projected.input).not.toHaveProperty("mode")
    expect(projected.input).not.toHaveProperty("timeoutMs")
    expect(JSON.stringify(projected)).not.toContain("opaque-error-key")
  })
})
