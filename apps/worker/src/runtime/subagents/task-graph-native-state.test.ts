import { describe, expect, it } from "vitest"

import { createInitialTaskGraphState, type TaskGraphNode } from "../planning/task-graph.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import type { TaskGraphNativeSourceProvenance } from "./task-graph-native-command.js"
import {
  appendTaskGraphNativeNode,
  parseTaskGraphNativeDelegation,
  parseTaskGraphNativeReceipt,
  TASK_GRAPH_NATIVE_METADATA_VERSION,
  TASK_GRAPH_NATIVE_TEMPLATE_ID,
  type TaskGraphNativeDelegationMetadata,
} from "./task-graph-native-state.js"

const source: TaskGraphNativeSourceProvenance = {
  taskId: "source-task", rootTaskId: "root-task", parentTaskId: "root-task", turnId: "turn-1",
  role: "auditor", taskType: "audit", status: "failed", attemptCount: 2,
  resultDigest: "a".repeat(64), graphNodeKey: "source-node", origin: "task_graph",
}
function metadata(overrides: Partial<TaskGraphNativeDelegationMetadata> = {}): TaskGraphNativeDelegationMetadata {
  return {
    schemaVersion: TASK_GRAPH_NATIVE_METADATA_VERSION, operationKind: "followup", operationId: "operation-1",
    requestFingerprint: "b".repeat(64), callerTaskId: "root-task", role: "auditor", taskType: "audit",
    contextDigest: "c".repeat(64), contextBytes: 16,
    source, ...overrides,
  }
}
function sourceNode(status: TaskGraphNode["status"] = "failed"): TaskGraphNode {
  return {
    key: "source-node", templateId: TASK_GRAPH_NATIVE_TEMPLATE_ID, goal: "Audit source", successCriteria: [],
    dependsOn: [], depth: 1, taskId: source.taskId, status, verificationDisposition: "legacy_unverified",
    nativeDelegation: metadata({ operationKind: "spawn", source: undefined }),
  }
}

describe("native TaskGraph state", () => {
  it("parses bounded metadata while excluding raw context and results", () => {
    const value = metadata()
    expect(parseTaskGraphNativeDelegation(value)).toEqual(value)
    expect(parseTaskGraphNativeDelegation({ ...value, context: { private: "do not expose" } })).toBeUndefined()
    expect(parseTaskGraphNativeDelegation({ ...value, source: { ...source, result: "raw result" } })).toBeUndefined()
  })

  it("records failed-source follow-up provenance without turning it into a successful dependency", () => {
    const state = { ...createInitialTaskGraphState(), revision: 1, nodes: [sourceNode("failed")] }
    const result = appendTaskGraphNativeNode({
      state, maxDepth: 8, key: "refinement", goal: "Refine source finding", successCriteria: [], dependsOn: [],
      metadata: metadata(),
    })

    expect(result.node.repairOf).toBeUndefined()
    expect(result.node.dependsOn).toEqual([])
    expect(result.node.verificationDisposition).toBe("legacy_unverified")
    expect(result.node.nativeDelegation?.source?.status).toBe("failed")
  })

  it("links a completed typed source after graph readback validation", () => {
    const completed = { ...source, status: "completed" as const, role: "analyst", taskType: "analysis" }
    const typed: TaskGraphNode = {
      key: "source-node", templateId: "analyst", goal: "Analyze source", successCriteria: ["Return one finding"],
      dependsOn: [], depth: 1, taskId: source.taskId, status: "completed", verificationDisposition: "typed",
      verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [{ id: "one-finding", check: { kind: "finding_count_gte", minimum: 1 } }] },
    }
    const state = { ...createInitialTaskGraphState(), revision: 1, nodes: [typed] }
    const result = appendTaskGraphNativeNode({
      state, maxDepth: 8, key: "refinement", goal: "Refine completed output", successCriteria: [], dependsOn: ["source-node"],
      metadata: metadata({ role: "analyst", taskType: "analysis", source: completed }), verifiedSource: true,
    })

    expect(result.node.dependsOn).toEqual(["source-node"])
    expect(result.node.depth).toBe(2)
  })

  it("does not create a successful edge from a completed typed source without verified owned readback", () => {
    const completed = { ...source, status: "completed" as const, role: "analyst", taskType: "analysis" }
    const typed: TaskGraphNode = {
      key: "source-node", templateId: "analyst", goal: "Analyze source", successCriteria: ["Return one finding"],
      dependsOn: [], depth: 1, taskId: source.taskId, status: "completed", verificationDisposition: "typed",
      verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [{ id: "one-finding", check: { kind: "finding_count_gte", minimum: 1 } }] },
    }
    const state = { ...createInitialTaskGraphState(), revision: 1, nodes: [typed] }
    const result = appendTaskGraphNativeNode({
      state, maxDepth: 8, key: "refinement", goal: "Refine completed output", successCriteria: [], dependsOn: [],
      metadata: metadata({ role: "analyst", taskType: "analysis", source: completed }),
    })
    expect(result.node.dependsOn).toEqual([])
  })

  it("round-trips frozen follow-up provenance in both first receipt and duplicate replay", () => {
    const receipt = {
      status: "accepted" as const, replay: false, operationId: "native-operation", requestFingerprint: "f".repeat(64),
      graphRevision: 2, nodeKey: "followup-node", dispatchDisposition: "pending" as const,
      child: { taskId: "child-task", rootTaskId: "root-task", parentTaskId: "root-task", path: "/root/child", depth: 1, role: "auditor", taskType: "audit", status: "queued" as const },
      source,
    }
    expect(parseTaskGraphNativeReceipt(receipt)).toEqual(receipt)
    const replay = { ...receipt, status: "duplicate" as const, replay: true }
    expect(parseTaskGraphNativeReceipt(replay)).toEqual(replay)
  })

  it("round-trips spawn receipts without the optional source field", () => {
    const receipt = {
      status: "accepted" as const, replay: false, operationId: "native-operation", requestFingerprint: "f".repeat(64),
      graphRevision: 1, nodeKey: "spawn-node", dispatchDisposition: "pending" as const,
      child: { taskId: "child-task", rootTaskId: "root-task", parentTaskId: "root-task", path: "/root/child", depth: 1, role: "executor", taskType: "preflight", status: "queued" as const },
    }
    expect(parseTaskGraphNativeReceipt(receipt)).toEqual(receipt)
    const replay = { ...receipt, status: "duplicate" as const, replay: true }
    expect(parseTaskGraphNativeReceipt(replay)).toEqual(replay)
    expect(parseTaskGraphNativeReceipt({ ...receipt, source: undefined })).toBeUndefined()
  })
})
