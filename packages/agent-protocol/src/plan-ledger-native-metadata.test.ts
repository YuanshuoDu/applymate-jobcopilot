import { describe, expect, it } from "vitest"

import { isStrictNativeTaskGraphNode } from "./plan-ledger-native-metadata.js"

const source = {
  taskId: "source-task", rootTaskId: "root-task", parentTaskId: "root-task", turnId: "turn-1",
  role: "auditor", taskType: "audit", status: "failed", attemptCount: 1,
  resultDigest: "d".repeat(64), graphNodeKey: "native-prior", origin: "task_graph",
}
const metadata = {
  schemaVersion: "agent-harness.v2.task-graph.native-delegation.v1", operationKind: "spawn",
  operationId: "native-operation", requestFingerprint: "a".repeat(64), callerTaskId: "root-task",
  role: "auditor", taskType: "audit", contextDigest: "b".repeat(64), contextBytes: 0,
}
const node = {
  key: "native-next", templateId: "native", goal: "Audit the source", successCriteria: [],
  dependsOn: [], depth: 1, taskId: "child-task", verificationDisposition: "legacy_unverified",
  nativeDelegation: metadata,
}

describe("strict native TaskGraph metadata recognition", () => {
  it("accepts actual spawn and followup metadata with empty native criteria", () => {
    expect(isStrictNativeTaskGraphNode(node)).toBe(true)
    expect(isStrictNativeTaskGraphNode({
      ...node,
      nativeDelegation: { ...metadata, operationKind: "followup", source },
    })).toBe(true)
    expect(isStrictNativeTaskGraphNode({
      ...node,
      nativeDelegation: {
        ...metadata, operationKind: "followup",
        source: { ...source, parentTaskId: null, graphNodeKey: null, origin: "native_legacy" },
      },
    })).toBe(true)
  })

  it("rejects foreign, mixed, unknown, and authority-bearing shapes", () => {
    const invalid = [
      { ...node, templateId: "scout" },
      { ...node, verificationDisposition: "typed" },
      { ...node, verification: {}, verificationDisposition: "typed" },
      { ...node, repairOf: {} },
      { ...node, nativeDelegation: { ...metadata, extra: true } },
      { ...node, nativeDelegation: { ...metadata, authority: "approved" } },
      { ...node, nativeDelegation: { ...metadata, operationKind: "followup" } },
      { ...node, nativeDelegation: { ...metadata, source } },
      { ...node, nativeDelegation: { ...metadata, source: { ...source, result: "private" }, operationKind: "followup" } },
      { ...node, nativeDelegation: { ...metadata, operationKind: "followup", source: { ...source, role: "executor" } } },
      { ...node, nativeDelegation: { ...metadata, operationKind: "followup", source: { ...source, origin: "native_legacy" } } },
      { ...node, nativeDelegation: { ...metadata, contextBytes: 40_001 } },
      { ...node, nativeDelegation: { ...metadata, requestFingerprint: "A".repeat(64) } },
      { ...node, nativeDelegation: { ...metadata, source: undefined, operationKind: "followup" } },
      { ...node, secret: "private" },
    ]
    for (const candidate of invalid) expect(isStrictNativeTaskGraphNode(candidate)).toBe(false)
  })

  it("rejects accessor-backed metadata values instead of invoking them", () => {
    const hostile = { ...metadata }
    Object.defineProperty(hostile, "contextDigest", { enumerable: true, get: () => "b".repeat(64) })
    expect(isStrictNativeTaskGraphNode({ ...node, nativeDelegation: hostile })).toBe(false)
  })

  it("requires primitive digest and status strings", () => {
    const stringLike = { toString: () => "a".repeat(64) }
    expect(isStrictNativeTaskGraphNode({
      ...node, nativeDelegation: { ...metadata, requestFingerprint: stringLike },
    })).toBe(false)
    expect(isStrictNativeTaskGraphNode({
      ...node, nativeDelegation: { ...metadata, operationKind: "followup", source: { ...source, resultDigest: stringLike } },
    })).toBe(false)
    expect(isStrictNativeTaskGraphNode({
      ...node, nativeDelegation: { ...metadata, operationKind: "followup", source: { ...source, status: { toString: () => "failed" } } },
    })).toBe(false)
  })
})
