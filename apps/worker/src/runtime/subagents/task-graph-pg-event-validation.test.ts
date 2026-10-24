import { describe, expect, it } from "vitest"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"

import { parsePersistedTaskGraphReceipt } from "./task-graph-pg-event-validation.js"
import { TASK_GRAPH_ITEM_TYPE, TASK_GRAPH_SNAPSHOT_VERSION, parseTaskGraphSnapshot, taskGraphItemId, taskGraphProposalKey, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { taskGraphSupersessionProposalKey } from "./task-graph-pg-supersession.js"

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

const supersessionObservedRevision = 4
const supersessionCancellationRevision = supersessionObservedRevision + 1
const supersessionRevision = supersessionCancellationRevision + 1
const supersessionLoaded = { ...loaded, revision: supersessionRevision }
const supersessionFingerprint = "b".repeat(64)
const supersessionOperationKey = `agent.plan.reconciliation:sha256:${"c".repeat(64)}`
const supersessionSnapshot: TaskGraphSnapshot = {
  schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
  nodes: [{ key: "replacement", templateId: "analyst", goal: "Inspect updated source", successCriteria: ["Evidence captured"], dependsOn: [], depth: 1, taskId: "child-2", verificationDisposition: "legacy_unverified" }],
}
function supersessionProposal(overrides: Record<string, unknown> = {}) {
  return proposal({
    observedRevision: supersessionObservedRevision, operationKey: supersessionOperationKey,
    fingerprint: supersessionFingerprint, revision: supersessionRevision,
    receipt: { status: "accepted", revision: supersessionRevision, nodes: [{ key: "replacement", taskId: "child-2", status: "queued" }], readyTaskIds: ["child-2"] },
    item: graphItem(supersessionRevision, { content: supersessionSnapshot }), content: supersessionSnapshot,
    ...overrides,
  })
}
function proposalIdentity(expectedRevision: number) {
  return { itemId: loaded.id, taskId: scope.parentTaskId, idempotencyKey: taskGraphProposalKey(scope.parentTaskId, expectedRevision) }
}
function supersessionIdentity(expectedRevision: number) {
  return { itemId: loaded.id, taskId: scope.parentTaskId, idempotencyKey: taskGraphSupersessionProposalKey(scope.parentTaskId, expectedRevision) }
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

  it("accepts the v2 R-to-R+1-to-R+2 plan receipt with its supersession key derived from R", () => {
    expect(parsePersistedTaskGraphReceipt("item.delta", supersessionProposal(), supersessionLoaded, supersessionSnapshot, scope,
      supersessionIdentity(supersessionObservedRevision))).toBeNull()
  })

  it("preserves v1 proposal identity keys derived from the final revision minus one", () => {
    expect(parsePersistedTaskGraphReceipt("item.delta", proposal({ fingerprint: "legacy opaque fingerprint" }), loaded, snapshot, scope,
      proposalIdentity(1))).toBeNull()
    expect(() => parsePersistedTaskGraphReceipt("item.delta", proposal(), loaded, snapshot, scope, proposalIdentity(0)))
      .toThrow("task_graph_receipt_invalid")
  })

  it("accepts an ordinary group-plan receipt keyed at the append revision after source cancellations", () => {
    const observedRevision = 4, sourceCount = 2, resultRevision = observedRevision + sourceCount + 1
    const groupLoaded = { ...loaded, revision: resultRevision }
    const groupSnapshot = parseTaskGraphSnapshot(snapshot)
    const groupProposal = proposal({
      revision: resultRevision,
      receipt: { status: "accepted", revision: resultRevision, nodes: [{ key: "child", taskId: "child-1", status: "queued" }], readyTaskIds: ["child-1"] },
      item: graphItem(resultRevision, { content: groupSnapshot }), content: groupSnapshot,
    })

    expect(parsePersistedTaskGraphReceipt("item.delta", groupProposal, groupLoaded, groupSnapshot, scope,
      proposalIdentity(observedRevision + sourceCount))).toBeNull()
    expect(() => parsePersistedTaskGraphReceipt("item.delta", groupProposal, groupLoaded, groupSnapshot, scope,
      proposalIdentity(observedRevision))).toThrow("task_graph_receipt_invalid")
  })

  it("rejects v2 proposals whose observed revision or event key does not bind the R-to-R+2 transition", () => {
    expect(() => parsePersistedTaskGraphReceipt("item.delta", supersessionProposal({ observedRevision: 5 }), supersessionLoaded, supersessionSnapshot, scope,
      supersessionIdentity(supersessionObservedRevision))).toThrow("task_graph_receipt_invalid")
    expect(() => parsePersistedTaskGraphReceipt("item.delta", supersessionProposal({ revision: supersessionCancellationRevision }),
      supersessionLoaded, supersessionSnapshot, scope, supersessionIdentity(supersessionObservedRevision))).toThrow("task_graph_receipt_invalid")
    expect(() => parsePersistedTaskGraphReceipt("item.delta", supersessionProposal(), supersessionLoaded, supersessionSnapshot, scope,
      supersessionIdentity(supersessionObservedRevision + 1))).toThrow("task_graph_receipt_invalid")
    expect(() => parsePersistedTaskGraphReceipt("item.delta", supersessionProposal(), supersessionLoaded, supersessionSnapshot, scope,
      proposalIdentity(supersessionObservedRevision))).toThrow("task_graph_receipt_invalid")
  })

  it.each([
    ["observedRevision", { operationKey: supersessionOperationKey }],
    ["operationKey", { observedRevision: supersessionObservedRevision }],
  ])("rejects a partial v2 marker missing %s", (_name, marker) => {
    const partial = { ...supersessionProposal(), ...marker }
    delete (partial as Record<string, unknown>)[_name]
    expect(() => parsePersistedTaskGraphReceipt("item.delta", partial, supersessionLoaded, supersessionSnapshot, scope,
      supersessionIdentity(supersessionObservedRevision))).toThrow("task_graph_receipt_invalid")
  })

  it("rejects v2 metadata on item.started and requires persisted event identity", () => {
    expect(() => parsePersistedTaskGraphReceipt("item.started", supersessionProposal(), supersessionLoaded, supersessionSnapshot, scope,
      supersessionIdentity(supersessionObservedRevision))).toThrow("task_graph_receipt_invalid")
    expect(() => parsePersistedTaskGraphReceipt("item.delta", supersessionProposal(), supersessionLoaded, supersessionSnapshot, scope))
      .toThrow("task_graph_receipt_invalid")
  })

  it("rejects v2 items and content that disagree with the final receipt revision or graph", () => {
    expect(() => parsePersistedTaskGraphReceipt("item.delta", supersessionProposal({ item: graphItem(supersessionRevision - 1, { content: supersessionSnapshot }) }),
      supersessionLoaded, supersessionSnapshot, scope, supersessionIdentity(supersessionObservedRevision))).toThrow("task_graph_receipt_invalid")
    expect(() => parsePersistedTaskGraphReceipt("item.delta", supersessionProposal({
      content: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [] },
    }), supersessionLoaded, supersessionSnapshot, scope, supersessionIdentity(supersessionObservedRevision))).toThrow("task_graph_receipt_invalid")
  })

  it.each([
    ["short", "f".repeat(63)],
    ["uppercase", "F".repeat(64)],
  ])("rejects a malformed v2 %s fingerprint", (_name, fingerprint) => {
    expect(() => parsePersistedTaskGraphReceipt("item.delta", supersessionProposal({ fingerprint }), supersessionLoaded, supersessionSnapshot, scope,
      supersessionIdentity(supersessionObservedRevision))).toThrow("task_graph_receipt_invalid")
  })

  it("rejects a malformed v2 reconciliation operation key", () => {
    expect(() => parsePersistedTaskGraphReceipt("item.delta", supersessionProposal({ operationKey: "reconciliation:bad" }),
      supersessionLoaded, supersessionSnapshot, scope, supersessionIdentity(supersessionObservedRevision))).toThrow("task_graph_receipt_invalid")
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
