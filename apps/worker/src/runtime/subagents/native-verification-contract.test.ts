import { describe, expect, it } from "vitest"

import {
  NATIVE_VERIFICATION_CONTROL_SCHEMA, digestNativeVerificationValue,
  nativeVerificationControlMatchesTask, parseNativeVerificationControl,
} from "./native-verification-contract.js"

const digest = "a".repeat(64)
const marker = {
  schemaVersion: NATIVE_VERIFICATION_CONTROL_SCHEMA,
  controlOperationId: "verify-op-1", controlTaskId: "verify-task-1",
  owner: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" },
  target: { kind: "child", nodeId: "node-1", nativeOperationId: "native-op-1", fingerprint: "f".repeat(64), taskId: "target-1", attempt: 2, resultDigest: digest },
  goalDigest: digest, criteriaDigest: digest, evidencePacketDigest: digest,
}

describe("native verification control contract", () => {
  it("accepts the exact versioned marker and matches the persisted task lineage", () => {
    const parsed = parseNativeVerificationControl(marker)
    expect(parsed).toEqual(marker)
    expect(nativeVerificationControlMatchesTask(parsed!, {
      id: "verify-task-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", role: "auditor",
    })).toBe(true)
  })

  it.each([
    ["unknown marker authority", { ...marker, approved: true }],
    ["wrong schema version", { ...marker, schemaVersion: "old" }],
    ["negative target attempt", { ...marker, target: { ...marker.target, attempt: 0 } }],
    ["invalid digest", { ...marker, evidencePacketDigest: "short" }],
    ["missing parent lineage", { ...marker, owner: { ...marker.owner, parentTaskId: undefined } }],
  ])("rejects %s", (_name, input) => expect(parseNativeVerificationControl(input)).toBeNull())

  it("rejects a followup task that inherited the original marker", () => {
    const parsed = parseNativeVerificationControl(marker)!
    expect(nativeVerificationControlMatchesTask(parsed, {
      id: "followup-task", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", role: "auditor",
    })).toBe(false)
  })

  it("parses another valid marker identity but refuses to match it to the original task", () => {
    const parsed = parseNativeVerificationControl({ ...marker, controlTaskId: "other-control-task" })!
    expect(nativeVerificationControlMatchesTask(parsed, {
      id: "verify-task-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", role: "auditor",
    })).toBe(false)
  })

  it("requires a SHA-256 fingerprint for child targets", () => {
    expect(parseNativeVerificationControl({ ...marker, target: { ...marker.target, fingerprint: "node" } })).toBeNull()
  })

  it("canonicalizes object key order before hashing", () => {
    expect(digestNativeVerificationValue({ b: 2, a: 1 })).toBe(digestNativeVerificationValue({ a: 1, b: 2 }))
    expect(digestNativeVerificationValue(["a", "b"])).not.toBe(digestNativeVerificationValue(["b", "a"]))
  })
})
