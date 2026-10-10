import { describe, expect, it } from "vitest"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"

import { parsePersistedTaskGraphReceipt } from "./task-graph-pg-event-validation.js"
import { TASK_GRAPH_ITEM_TYPE, TASK_GRAPH_SNAPSHOT_VERSION, taskGraphItemId, type TaskGraphSnapshot } from "./task-graph-snapshot.js"

const scope = { sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
const snapshot: TaskGraphSnapshot = {
  schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
  nodes: [{ key: "child", templateId: "analyst", goal: "Inspect source", successCriteria: ["Evidence captured"], dependsOn: [], depth: 1, taskId: "child-1" }],
}
const loaded = { id: taskGraphItemId(scope.parentTaskId), revision: 4 }

function graphItem(revision = 2, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: loaded.id, sessionId: scope.sessionId,
    turnId: scope.turnId, stepId: "step-1", taskId: scope.parentTaskId, type: TASK_GRAPH_ITEM_TYPE,
    status: "streaming", phase: null, revision, content: snapshot, ...overrides,
  }
}

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    kind: "proposal", fingerprint: "a".repeat(64), revision: 2,
    receipt: { status: "accepted", revision: 2, nodes: [{ key: "child", taskId: "child-1", status: "queued" }], readyTaskIds: ["child-1"] },
    item: graphItem(), content: snapshot, ...overrides,
  }
}

function lifecycle(overrides: Record<string, unknown> = {}) {
  return {
    kind: "lifecycle", revision: 2,
    event: { type: "task.completed", idempotencyKey: "event-1", nodeKey: "child", expectedRevision: 1 },
    item: graphItem(), ...overrides,
  }
}

describe("persisted TaskGraph event envelopes", () => {
  it.each([
    ["missing kind", { revision: 2 }],
    ["unknown kind", { kind: "other", revision: 2 }],
  ])("rejects an item.delta with %s", (_name, payload) => {
    expect(() => parsePersistedTaskGraphReceipt("item.delta", payload, loaded, snapshot, scope))
      .toThrow("task_graph_event_envelope_invalid")
  })

  it("accepts a valid persisted proposal receipt without applying it as a lifecycle event", () => {
    expect(parsePersistedTaskGraphReceipt("item.delta", proposal(), loaded, snapshot, scope)).toBeNull()
  })

  it("accepts the legacy first item.started proposal without top-level content but requires delta content", () => {
    const { content: _content, ...first } = proposal({
      revision: 1, receipt: { status: "accepted", revision: 1, nodes: [{ key: "child", taskId: "child-1", status: "queued" }], readyTaskIds: ["child-1"] },
      item: graphItem(1),
    })
    expect(parsePersistedTaskGraphReceipt("item.started", first, loaded, snapshot, scope)).toBeNull()
    expect(() => parsePersistedTaskGraphReceipt("item.delta", first, loaded, snapshot, scope)).toThrow("task_graph_receipt_invalid")
  })

  it("accepts a valid task_graph.lifecycle envelope and rejects proposal kinds on that event type", () => {
    expect(parsePersistedTaskGraphReceipt("task_graph.lifecycle", lifecycle(), loaded, snapshot, scope)).toMatchObject({
      type: "task.completed", nodeKey: "child", expectedRevision: 1,
    })
    expect(() => parsePersistedTaskGraphReceipt("task_graph.lifecycle", proposal(), loaded, snapshot, scope))
      .toThrow("task_graph_event_envelope_invalid")
  })

  it("rejects a malformed proposal receipt body", () => {
    expect(() => parsePersistedTaskGraphReceipt("item.delta", proposal({ receipt: { revision: 2, nodes: "bad" } }), loaded, snapshot, scope))
      .toThrow("task_graph_receipt_invalid")
  })

  it("rejects a malformed lifecycle event body", () => {
    expect(() => parsePersistedTaskGraphReceipt("task_graph.lifecycle", lifecycle({ event: { type: "task.completed" } }), loaded, snapshot, scope))
      .toThrow("task_graph_lifecycle_event_invalid")
  })

  it("rejects an invalid lifecycle revision or mismatched nested item", () => {
    expect(() => parsePersistedTaskGraphReceipt("item.delta", lifecycle({ revision: "2" }), loaded, snapshot, scope))
      .toThrow("task_graph_lifecycle_receipt_invalid")
    expect(() => parsePersistedTaskGraphReceipt("item.delta", lifecycle({ item: graphItem(2, { sessionId: "other-session" }) }), loaded, snapshot, scope))
      .toThrow("task_graph_receipt_invalid")
  })

  it("rejects nested item content that disagrees with the current persisted revision", () => {
    expect(() => parsePersistedTaskGraphReceipt("item.delta", lifecycle({
      revision: 4, event: { type: "task.completed", idempotencyKey: "event-1", nodeKey: "child", expectedRevision: 3 },
      item: graphItem(4, { content: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [] } }),
    }), loaded, snapshot, scope)).toThrow("task_graph_receipt_invalid")
  })
})
