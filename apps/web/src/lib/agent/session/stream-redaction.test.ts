import { describe, expect, it } from "vitest"

import { redactStreamEventPayload, redactStreamString, redactStreamValue } from "./stream-redaction"

const identity = { sessionId: "session-1", turnId: "turn-1", itemId: "graph-1", taskId: "root-1" }
const childIdentity = { ...identity, taskId: "task-1" }
const graphVersion = "agent-harness.v2.task-graph"

function item(content: unknown, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "agent-harness.v2", id: "graph-1", sessionId: "session-1", turnId: "turn-1", stepId: null,
    taskId: "root-1", type: "task_graph", status: "streaming", phase: null, revision: 1, content,
    startedAt: "2026-09-28T00:00:00.000Z", completedAt: null,
    createdAt: "2026-09-28T00:00:00.000Z", updatedAt: "2026-09-28T00:00:00.000Z", ...overrides,
  }
}

function node(key: string, taskId: string, dependsOn: string[] = [], overrides: Record<string, unknown> = {}) {
  return {
    key, templateId: `template-${key}`, goal: "Inspect the role", successCriteria: ["Summarize fit"],
    dependsOn, depth: 1, taskId, ...overrides,
  }
}

function content(nodes: unknown[], schemaVersion = graphVersion, extra: Record<string, unknown> = {}) {
  return { schemaVersion, nodes, ...extra }
}

describe("agent stream redaction", () => {
  it("redacts credential-shaped strings", () => {
    expect(redactStreamString("Bearer very-secret-token sk-12345678")).toBe("Bearer [REDACTED] [REDACTED]")
  })

  it("redacts nested credential, resume, and raw payload keys", () => {
    expect(redactStreamValue({ data: { token: "private", resume: "full CV", rawContent: "raw" }, title: "safe" })).toEqual({
      data: { token: "[REDACTED]", resume: "[REDACTED]", rawContent: "[REDACTED]" }, title: "safe",
    })
  })

  it("preserves only a valid TaskGraph item and still redacts its goal strings", () => {
    const validPayload = { kind: "lifecycle", event: { type: "task.completed", nodeKey: "research" }, revision: 1, item: item(content([
      node("research", "task-1", [], { goal: "Review this role; Bearer very-secret-token" }),
    ])) }
    const preserved = redactStreamEventPayload("item.delta", validPayload, childIdentity) as {
      item: { content: { nodes: Array<{ goal: string; taskId: string }> } }
    }
    expect(preserved.item.content.nodes[0]?.goal).toBe("Review this role; Bearer [REDACTED]")
    expect(preserved.item.content.nodes[0]?.taskId).toBe("task-1")

    const unrelated = redactStreamEventPayload("item.delta", {
      item: item({ text: "private transcript" }, { type: "agent_message" }),
    }, identity) as { item: { content: unknown } }
    expect(unrelated.item.content).toBe("[REDACTED]")

    const wrongEventType = redactStreamEventPayload("task_graph", validPayload, childIdentity) as {
      item: { content: unknown }
    }
    expect(wrongEventType.item.content).toBe("[REDACTED]")

    const malformedEvent = redactStreamEventPayload("item.delta", { item: item(content([node("research", "task-1")])) }, childIdentity) as {
      item: { content: unknown }
    }
    expect(malformedEvent.item.content).toBe("[REDACTED]")
  })

  it("keeps proposal snapshots strictly attributed to the root task", () => {
    const proposal = {
      kind: "proposal", fingerprint: "task-graph:fingerprint", receipt: { status: "accepted" }, revision: 1,
      item: item(content([node("research", "task-1")])),
    }
    const rootResult = redactStreamEventPayload("item.delta", proposal, identity) as { item: { content: { nodes: unknown[] } } }
    expect(rootResult.item.content.nodes).toHaveLength(1)

    const childResult = redactStreamEventPayload("item.delta", proposal, childIdentity) as { item: { content: unknown } }
    expect(childResult.item.content).toBe("[REDACTED]")
  })

  it.each([
    ["unknown node key", "missing", "task-1"],
    ["node key owned by a different child", "analyst", "task-1"],
    ["child node attributed to the root task", "research", "root-1"],
    ["missing node key", undefined, "task-1"],
  ])("generically redacts a lifecycle snapshot with %s", (_case, nodeKey, taskId) => {
    const event = { type: "task.completed", ...(nodeKey === undefined ? {} : { nodeKey }) }
    const payload = {
      kind: "lifecycle", event, revision: 1,
      item: item(content([node("research", "task-1"), node("analyst", "task-2")])),
    }
    const result = redactStreamEventPayload("item.delta", payload, { ...identity, taskId }) as { item: { content: unknown } }
    expect(result.item.content).toBe("[REDACTED]")
  })

  it.each([
    ["sessionId", { ...childIdentity, sessionId: "other-session" }],
    ["turnId", { ...childIdentity, turnId: "other-turn" }],
    ["itemId", { ...childIdentity, itemId: "other-graph" }],
    ["taskId", { ...childIdentity, taskId: "other-child" }],
  ])("generically redacts a valid snapshot when its %s differs from the stream envelope", (_field, eventIdentity) => {
    const validPayload = { kind: "lifecycle", event: { type: "task.completed", nodeKey: "research" }, revision: 1, item: item(content([node("research", "task-1")])) }
    const result = redactStreamEventPayload("item.delta", validPayload, eventIdentity) as { item: { content: unknown } }
    expect(result.item.content).toBe("[REDACTED]")
  })

  it.each([
    ["unknown schema version", content([node("research", "task-1")], "future.task-graph")],
    ["extra snapshot key", content([node("research", "task-1")], graphVersion, { raw: "private" })],
    ["extra node key", content([{ ...node("research", "task-1"), prompt: "private" }])],
    ["duplicate graph keys", content([node("same", "task-1"), node("same", "task-2")])],
    ["duplicate task IDs", content([node("research", "task-1"), node("review", "task-1")])],
    ["duplicate dependencies", content([node("base", "task-1"), node("next", "task-2", ["base", "base"])])],
    ["missing dependency", content([node("research", "task-1", ["missing"])])],
    ["cyclic dependencies", content([node("research", "task-1", ["review"]), node("review", "task-2", ["research"])])],
    ["depth beyond MAX_DEPTH", content([node("research", "task-1", [], { depth: 9 })])],
    ["goal beyond its bound", content([node("research", "task-1", [], { goal: "g".repeat(1_201) })])],
    ["success criteria count beyond its bound", content([node("research", "task-1", [], { successCriteria: Array(9).fill("criterion") })])],
    ["success criterion beyond its bound", content([node("research", "task-1", [], { successCriteria: ["c".repeat(321)] })])],
    ["dependency count beyond its bound", content([node("research", "task-1", Array(9).fill("dependency"))])],
    ["node count beyond MAX_NODES", content(Array.from({ length: 9 }, (_, index) => node(`n${index}`, `task-${index}`)))],
    ["encoded bytes beyond their bound", content(Array.from({ length: 8 }, (_, index) => node(
      `n${index}`, `task-${index}`, [], { goal: "€".repeat(1_200), successCriteria: Array(8).fill("€".repeat(320)) },
    )))],
  ])("falls back to generic redaction for a snapshot with %s", (_name, invalidSnapshot) => {
    const result = redactStreamEventPayload("item.started", { item: item(invalidSnapshot) }, identity) as {
      item: { content: unknown }
    }
    expect(result.item.content).toBe("[REDACTED]")
  })

  it("uses generic redaction for non-TaskGraph content even inside a TaskGraph event type", () => {
    expect(redactStreamEventPayload("item.delta", { content: "ordinary content" }, identity)).toEqual({ content: "[REDACTED]" })
  })
})
