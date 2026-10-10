import { describe, expect, it } from "vitest"

import type { TaskGraphCurrentState } from "./subagents/task-graph-command-port.js"
import { nativeCoordinationReceipts, nativeGraphNodeFields, nativeReceiptsMatchGraph } from "./canonical-turn-native-graph-context.js"
import { NATIVE_COORDINATION_RECEIPT_SCHEMA } from "./tools/task-graph-coordination-bridge.js"

const digest = "a".repeat(64)
const receipt = {
  schemaVersion: NATIVE_COORDINATION_RECEIPT_SCHEMA, operationKind: "spawn", status: "accepted", replay: false,
  operationId: "operation-1", requestFingerprint: digest, graphRevision: 2, nodeKey: "node-1",
  dispatchDisposition: "pending", rootTaskId: "root-1",
  child: { taskId: "child-1", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/child-1", depth: 1, role: "scout", taskType: "research", status: "queued" },
}

function graph(overrides: Partial<TaskGraphCurrentState> = {}): TaskGraphCurrentState {
  return {
    revision: 3,
    nodes: [{
      key: "node-1", templateId: "native:scout", goal: "Inspect", successCriteria: [], dependsOn: [], taskId: "child-1",
      status: "completed", readiness: "terminal", resultSummary: null, failureReason: null,
      native: { operationKind: "spawn", operationId: "operation-1", requestFingerprint: digest, callerTaskId: "root-1", role: "scout", taskType: "research", contextDigest: digest },
    }],
    ...overrides,
  }
}

describe("canonical native graph context", () => {
  it("preserves safe native identity and result digests without raw context or results", () => {
    const fields = nativeGraphNodeFields({
      native: { operationKind: "followup", operationId: "operation-2", requestFingerprint: digest, callerTaskId: "root-1", role: "analyst", taskType: "review", contextDigest: digest,
        source: { taskId: "source-1", rootTaskId: "root-1", parentTaskId: "root-1", turnId: "turn-1", role: "analyst", taskType: "review", status: "cancelled", attemptCount: 0, resultDigest: digest, graphNodeKey: null, origin: "native_legacy" } },
      nativeResult: { schemaVersion: "agent-harness.v2.task-graph.native-result.v1", role: "analyst", taskStatus: "completed", disposition: "opaque", resultDigest: digest },
      context: { private: "must not appear" }, result: { private: "must not appear" },
    })

    expect(fields.native?.source).toMatchObject({ taskId: "source-1", attemptCount: 0, origin: "native_legacy" })
    expect(fields.nativeResult).toMatchObject({ disposition: "opaque", resultDigest: digest })
    expect(JSON.stringify(fields)).not.toContain("private")
  })

  it("rejects unsafe additions or inconsistent native result roles", () => {
    expect(() => nativeGraphNodeFields({ native: { operationKind: "spawn", extra: "raw" } })).toThrow("task_graph_current_state_invalid:native")
    expect(() => nativeGraphNodeFields({
      native: { operationKind: "spawn", operationId: "operation-1", requestFingerprint: digest, callerTaskId: "root-1", role: "scout", taskType: "research", contextDigest: digest },
      nativeResult: { schemaVersion: "agent-harness.v2.task-graph.native-result.v1", role: "analyst", taskStatus: "completed", disposition: "structured", resultDigest: digest },
    })).toThrow("task_graph_current_state_invalid:native")
  })

  it("recovers only strict server-generated receipts and matches immutable graph identity", () => {
    const snapshot = { toolObservations: [
      { id: "one", content: { toolName: "agent.spawn", status: "completed", output: { nativeCoordination: receipt } } },
      { id: "two", content: { toolName: "jobs.search", status: "completed", output: { nativeCoordination: receipt } } },
    ] } as never
    const required = nativeCoordinationReceipts(snapshot)

    expect(required).toHaveLength(1)
    expect(nativeReceiptsMatchGraph(required, graph(), "root-1")).toBe(true)
    expect(nativeReceiptsMatchGraph(required, graph({ nodes: [] }), "root-1")).toBe(false)
    expect(nativeReceiptsMatchGraph(required, graph(), "other-root")).toBe(false)
  })

  it("rejects a malformed persisted native receipt instead of forgetting the graph requirement", () => {
    const snapshot = { toolObservations: [{ id: "one", content: { toolName: "spawn_subagent", status: "completed", output: { nativeCoordination: { ...receipt, child: { ...receipt.child, privateContext: "raw" } } } } }] } as never
    expect(() => nativeCoordinationReceipts(snapshot)).toThrow("native_coordination_receipt_invalid")
  })
})
