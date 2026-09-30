import { describe, expect, it } from "vitest"
import { TASK_GRAPH_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"

import { redactStreamEventPayload, redactStreamString, redactStreamValue } from "./stream-redaction"

const turnId = "p3-task-graph-resume-turn-12345678-1234-4234-8234-123456789012"
const rootTaskId = `root-${turnId}`
const childTaskId = "subagent-12345678-1234-4234-8234-123456789012"
const secondChildTaskId = "subagent-87654321-9876-4abc-8def-012345678901"
const sessionId = "session-12345678-1234-4234-8234-123456789012"
const itemId = `task-graph-${"12345678".repeat(8)}`
const identity = { sessionId, turnId, itemId, taskId: rootTaskId }
const childIdentity = { ...identity, taskId: childTaskId }
const graphVersion = TASK_GRAPH_SCHEMA_VERSION

function item(content: unknown, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "agent-harness.v2", id: itemId, sessionId, turnId, stepId: null,
    taskId: rootTaskId, type: "task_graph", status: "streaming", phase: null, revision: 1, content,
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
      node("research", childTaskId, [], {
        goal: "Review this role 123-456-7890; Bearer very-secret-token",
        successCriteria: ["Call 987-654-3210", "Bearer very-secret-token"],
      }),
    ])) }
    const preserved = redactStreamEventPayload("item.delta", validPayload, childIdentity) as {
      item: { id: string | null; sessionId: string; turnId: string; taskId: string; content: { nodes: Array<{ goal: string; successCriteria: string[]; taskId: string }> } }
    }
    expect(preserved.item).toMatchObject({ id: identity.itemId, sessionId: identity.sessionId, turnId, taskId: rootTaskId })
    expect(preserved.item.content.nodes[0]?.goal).toBe("Review this role [REDACTED_PHONE]; Bearer [REDACTED]")
    expect(preserved.item.content.nodes[0]?.successCriteria).toEqual(["Call [REDACTED_PHONE]", "Bearer [REDACTED]"])
    expect(preserved.item.content.nodes[0]?.taskId).toBe(childTaskId)

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

  it("preserves legacy TaskGraph identifiers with surrounding whitespace when generic redaction leaves them unchanged", () => {
    const legacyTaskId = " task-1 "
    const legacyIdentity = { sessionId: "session-legacy", turnId: "turn-legacy", itemId: "graph-legacy", taskId: legacyTaskId }
    const payload = {
      kind: "lifecycle", event: { type: "task.completed", nodeKey: " research " }, revision: 1,
      item: item(content([node(" research ", legacyTaskId)]), {
        id: legacyIdentity.itemId, sessionId: legacyIdentity.sessionId, turnId: legacyIdentity.turnId, taskId: "root-legacy",
      }),
    }
    const result = redactStreamEventPayload("item.delta", payload, legacyIdentity) as {
      item: { content: { nodes: Array<{ key: string; taskId: string }> } }
    }

    expect(result.item.content.nodes[0]).toMatchObject({ key: " research ", taskId: legacyTaskId })
  })

  it("fails closed for an arbitrary phone-like task ID", () => {
    const unsafeTaskId = "unsafe-12345678-1234-4234-8234-123456789012"
    const payload = {
      kind: "lifecycle", event: { type: "task.completed", nodeKey: "research" }, revision: 1,
      item: item(content([node("research", unsafeTaskId)])),
    }
    const result = redactStreamEventPayload("item.delta", payload, { ...identity, taskId: unsafeTaskId }) as {
      item: { taskId: string; content: unknown }
    }

    expect(result.item.content).toBe("[REDACTED]")
    expect(result.item.taskId).not.toBe(rootTaskId)
    expect(result.item.taskId).toContain("[REDACTED_PHONE]")
  })

  it("fails closed when the root task ID is not generated from its turn ID", () => {
    const unsafeRootTaskId = "root-12345678-1234-4234-8234-123456789012"
    const payload = {
      kind: "lifecycle", event: { type: "task.completed", nodeKey: "research" }, revision: 1,
      item: item(content([node("research", childTaskId)]), { taskId: unsafeRootTaskId }),
    }
    const result = redactStreamEventPayload("item.delta", payload, childIdentity) as {
      item: { taskId: string; content: unknown }
    }

    expect(result.item.content).toBe("[REDACTED]")
    expect(result.item.taskId).not.toBe(unsafeRootTaskId)
    expect(result.item.taskId).toContain("[REDACTED_PHONE]")
  })

  it("keeps proposal snapshots strictly attributed to the root task", () => {
    const proposal = {
      kind: "proposal", fingerprint: "task-graph:fingerprint", receipt: { status: "accepted" }, revision: 1,
      item: item(content([node("research", childTaskId)])),
    }
    const rootResult = redactStreamEventPayload("item.delta", proposal, identity) as { item: { content: { nodes: unknown[] } } }
    expect(rootResult.item.content.nodes).toHaveLength(1)

    const childResult = redactStreamEventPayload("item.delta", proposal, childIdentity) as { item: { content: unknown } }
    expect(childResult.item.content).toBe("[REDACTED]")
  })

  it("preserves a generated subagent root ID when the graph owner was created without a parent", () => {
    const proposal = {
      kind: "proposal", fingerprint: "task-graph:fingerprint", receipt: { status: "accepted" }, revision: 1,
      item: item(content([node("research", childTaskId)]), { taskId: secondChildTaskId }),
    }
    const result = redactStreamEventPayload("item.delta", proposal, { ...identity, taskId: secondChildTaskId }) as {
      item: { taskId: string; content: { nodes: Array<{ taskId: string }> } }
    }

    expect(result.item.taskId).toBe(secondChildTaskId)
    expect(result.item.content.nodes[0]?.taskId).toBe(childTaskId)
  })

  it.each([
    ["unknown node key", "missing", childTaskId],
    ["node key owned by a different child", "analyst", childTaskId],
    ["child node attributed to the root task", "research", rootTaskId],
    ["missing node key", undefined, childTaskId],
  ])("generically redacts a lifecycle snapshot with %s", (_case, nodeKey, taskId) => {
    const event = { type: "task.completed", ...(nodeKey === undefined ? {} : { nodeKey }) }
    const payload = {
      kind: "lifecycle", event, revision: 1,
      item: item(content([node("research", childTaskId), node("analyst", secondChildTaskId)])),
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
    const validPayload = { kind: "lifecycle", event: { type: "task.completed", nodeKey: "research" }, revision: 1, item: item(content([node("research", childTaskId)])) }
    const result = redactStreamEventPayload("item.delta", validPayload, eventIdentity) as { item: { content: unknown } }
    expect(result.item.content).toBe("[REDACTED]")
  })

  it.each([
    ["unknown schema version", content([node("research", childTaskId)], "future.task-graph")],
    ["extra snapshot key", content([node("research", childTaskId)], graphVersion, { raw: "private" })],
    ["extra node key", content([{ ...node("research", childTaskId), prompt: "private" }])],
    ["duplicate graph keys", content([node("same", childTaskId), node("same", secondChildTaskId)])],
    ["duplicate task IDs", content([node("research", childTaskId), node("review", childTaskId)])],
    ["duplicate dependencies", content([node("base", childTaskId), node("next", secondChildTaskId, ["base", "base"])])],
    ["missing dependency", content([node("research", childTaskId, ["missing"])])],
    ["cyclic dependencies", content([node("research", childTaskId, ["review"]), node("review", secondChildTaskId, ["research"])])],
    ["depth beyond MAX_DEPTH", content([node("research", childTaskId, [], { depth: 9 })])],
    ["goal beyond its bound", content([node("research", childTaskId, [], { goal: "g".repeat(1_201) })])],
    ["success criteria count beyond its bound", content([node("research", childTaskId, [], { successCriteria: Array(9).fill("criterion") })])],
    ["success criterion beyond its bound", content([node("research", childTaskId, [], { successCriteria: ["c".repeat(321)] })])],
    ["dependency count beyond its bound", content([node("research", childTaskId, Array(9).fill("dependency"))])],
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
