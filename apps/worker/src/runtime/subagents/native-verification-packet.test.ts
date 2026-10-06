import { describe, expect, it } from "vitest"

import {
  NATIVE_VERIFICATION_CONTROL_SCHEMA, NATIVE_VERIFICATION_PACKET_SCHEMA,
  canonicalNativeVerificationJson, digestNativeVerificationValue, type NativeVerificationControl, type NativeVerificationPacket,
} from "./native-verification-contract.js"
import { createNativeVerificationContext, parseNativeVerificationPacket } from "./native-verification-packet.js"

const persistedResult = { status: "completed", finalText: "The target's output" }
const basePacket: NativeVerificationPacket = {
  schemaVersion: NATIVE_VERIFICATION_PACKET_SCHEMA,
  controlOperationId: "verify-op", controlTaskId: "verify-task", goal: "Produce the requested result",
  criteria: [{ criterionId: "criterion-1", requirement: "The result satisfies the request" }],
  target: { kind: "child", taskId: "target-task", attempt: 3, resultDigest: digestNativeVerificationValue(persistedResult), referenceId: "target-result", resultText: canonicalNativeVerificationJson(persistedResult) },
  evidence: [{ referenceId: "fact-1", kind: "tool_result", summary: "Owned result confirms the requested value." }],
}
function control(packet: NativeVerificationPacket = basePacket): NativeVerificationControl {
  return {
    schemaVersion: NATIVE_VERIFICATION_CONTROL_SCHEMA,
    controlOperationId: packet.controlOperationId, controlTaskId: packet.controlTaskId,
    owner: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" },
    target: { kind: "child", nodeId: "node-1", nativeOperationId: "native-op", fingerprint: "f".repeat(64), taskId: "target-task", attempt: 3, resultDigest: digestNativeVerificationValue(persistedResult) },
    goalDigest: digestNativeVerificationValue(packet.goal), criteriaDigest: digestNativeVerificationValue(packet.criteria),
    evidencePacketDigest: digestNativeVerificationValue(packet),
  }
}

describe("native verification packet", () => {
  it("parses a bounded server packet only when all frozen digests and target bindings match", () => {
    const parsed = parseNativeVerificationPacket(createNativeVerificationContext(basePacket), control())
    expect(parsed).toEqual(basePacket)
  })

  it.each([
    ["ordinary context fields", { ...createNativeVerificationContext(basePacket), query: "private persona" }],
    ["wrong criterion ID", createNativeVerificationContext({ ...basePacket, criteria: [{ ...basePacket.criteria[0], criterionId: "other" }] })],
    ["foreign result task", createNativeVerificationContext({ ...basePacket, target: { ...basePacket.target, taskId: "foreign-task" } })],
    ["foreign target digest", createNativeVerificationContext({ ...basePacket, target: { ...basePacket.target, resultDigest: "c".repeat(64) } })],
    ["unrelated child result text", createNativeVerificationContext({ ...basePacket, target: { ...basePacket.target, resultText: canonicalNativeVerificationJson({ finalText: "unrelated" }) } })],
    ["foreign evidence reference", createNativeVerificationContext({ ...basePacket, evidence: [{ ...basePacket.evidence[0], referenceId: "target-result" }] })],
    ["wrong packet hash", createNativeVerificationContext({ ...basePacket, goal: "changed after freezing" })],
  ])("rejects %s", (_name, context) => expect(parseNativeVerificationPacket(context, control())).toBeNull())

  it("rejects sparse criteria and packet context without the exact packet key", () => {
    const sparse = new Array(1)
    const packet = { ...basePacket, criteria: sparse }
    const context = createNativeVerificationContext(packet as unknown as NativeVerificationPacket)
    expect(parseNativeVerificationPacket(context, control())).toBeNull()
    expect(parseNativeVerificationPacket({ nativeVerificationPacket: basePacket, extra: true }, control())).toBeNull()
  })

  it("recomputes root candidate text digest before accepting its packet", () => {
    const rootTarget = { kind: "root_goal" as const, candidateDigest: digestNativeVerificationValue("delivery"), referenceId: "candidate", candidateText: "delivery" }
    const rootPacket: NativeVerificationPacket = { ...basePacket, target: rootTarget }
    const rootControl = { ...control(basePacket), target: { kind: "root_goal" as const, candidateDigest: rootTarget.candidateDigest, childBindingSetDigest: "e".repeat(64) }, evidencePacketDigest: digestNativeVerificationValue(rootPacket) }
    expect(parseNativeVerificationPacket(createNativeVerificationContext(rootPacket), rootControl)).toEqual(rootPacket)
    const changed = { ...rootPacket, target: { ...rootTarget, candidateText: "foreign delivery" } }
    const rebound = { ...rootControl, evidencePacketDigest: digestNativeVerificationValue(changed) }
    expect(parseNativeVerificationPacket(createNativeVerificationContext(changed), rebound)).toBeNull()
  })
})
