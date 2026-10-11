import { describe, expect, it } from "vitest"
import { Buffer } from "node:buffer"

import {
  NATIVE_VERIFICATION_CONTROL_SCHEMA, NATIVE_VERIFICATION_PACKET_SCHEMA,
  NATIVE_VERIFICATION_PACKET_SCHEMA_V2, NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND,
  canonicalNativeVerificationJson, digestNativeVerificationValue, type NativeVerificationControl, type NativeVerificationPacket,
} from "./native-verification-contract.js"
import { createNativeVerificationContext, parseNativeVerificationPacket } from "./native-verification-packet.js"

const persistedResult = { status: "completed", finalText: "The target's output" }
const childTarget: Extract<NativeVerificationPacket["target"], { kind: "child" }> = {
  kind: "child", taskId: "target-task", attempt: 3, resultDigest: digestNativeVerificationValue(persistedResult),
  referenceId: "target-result", resultText: canonicalNativeVerificationJson(persistedResult),
}
const basePacket: NativeVerificationPacket = {
  schemaVersion: NATIVE_VERIFICATION_PACKET_SCHEMA,
  controlOperationId: "verify-op", controlTaskId: "verify-task", goal: "Produce the requested result",
  criteria: [{ criterionId: "criterion-1", requirement: "The result satisfies the request" }],
  target: childTarget,
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
const rootTarget: Extract<NativeVerificationPacket["target"], { kind: "root_goal" }> = {
  kind: "root_goal", candidateDigest: digestNativeVerificationValue("delivery"), referenceId: "candidate", candidateText: "delivery",
}
const selfReference = `user-self-attestation:${"a".repeat(64)}`
function rootPacket(
  evidence: NativeVerificationPacket["evidence"],
  schemaVersion: NativeVerificationPacket["schemaVersion"] = NATIVE_VERIFICATION_PACKET_SCHEMA,
): NativeVerificationPacket {
  return { ...basePacket, schemaVersion, target: rootTarget, evidence }
}
function rootControl(packet: NativeVerificationPacket): NativeVerificationControl {
  return {
    schemaVersion: NATIVE_VERIFICATION_CONTROL_SCHEMA, controlOperationId: packet.controlOperationId, controlTaskId: packet.controlTaskId,
    owner: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" },
    target: { kind: "root_goal", candidateDigest: rootTarget.candidateDigest, childBindingSetDigest: "e".repeat(64) },
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
    ["foreign result task", createNativeVerificationContext({ ...basePacket, target: { ...childTarget, taskId: "foreign-task" } })],
    ["foreign target digest", createNativeVerificationContext({ ...basePacket, target: { ...childTarget, resultDigest: "c".repeat(64) } })],
    ["unrelated child result text", createNativeVerificationContext({ ...basePacket, target: { ...childTarget, resultText: canonicalNativeVerificationJson({ finalText: "unrelated" }) } })],
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
    const rootPacket: NativeVerificationPacket = { ...basePacket, target: rootTarget }
    const binding = rootControl(rootPacket)
    expect(parseNativeVerificationPacket(createNativeVerificationContext(rootPacket), binding)).toEqual(rootPacket)
    const changed = { ...rootPacket, target: { ...rootTarget, candidateText: "foreign delivery" } }
    const rebound = { ...binding, evidencePacketDigest: digestNativeVerificationValue(changed) }
    expect(parseNativeVerificationPacket(createNativeVerificationContext(changed), rebound)).toBeNull()
  })

  it("accepts evidence summaries through 8 KiB and rejects larger summaries without clipping", () => {
    const bounded: NativeVerificationPacket = { ...basePacket, evidence: [{ referenceId: "fact-1", kind: "tool_result", summary: "x".repeat(8 * 1024) }] }
    expect(parseNativeVerificationPacket(createNativeVerificationContext(bounded), control(bounded))).toEqual(bounded)
    const oversized: NativeVerificationPacket = { ...basePacket, evidence: [{ referenceId: "fact-1", kind: "tool_result", summary: "x".repeat(8 * 1024 + 1) }] }
    expect(parseNativeVerificationPacket(createNativeVerificationContext(oversized), control(oversized))).toBeNull()
  })

  it("retains the 32 KiB aggregate packet cap when several bounded evidence summaries are present", () => {
    const packet: NativeVerificationPacket = {
      ...basePacket,
      evidence: ["fact-1", "fact-2", "fact-3", "fact-4"].map(referenceId => ({ referenceId, kind: "tool_result" as const, summary: "x".repeat(8_100) })),
    }
    expect(Buffer.byteLength(canonicalNativeVerificationJson(packet), "utf8")).toBeGreaterThan(32 * 1024)
    expect(parseNativeVerificationPacket(createNativeVerificationContext(packet), control(packet))).toBeNull()
  })

  it("keeps v1 root and child packets unchanged and reserves user statements for root v2", () => {
    const legacyRoot = rootPacket([{ referenceId: "root-fact", kind: "tool_result", summary: "Owned facts." }])
    expect(parseNativeVerificationPacket(createNativeVerificationContext(legacyRoot), rootControl(legacyRoot))).toEqual(legacyRoot)
    const statement = { referenceId: selfReference, kind: NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND, summary: "User stated a preference." }
    const v1WithStatement = rootPacket([statement])
    expect(parseNativeVerificationPacket(createNativeVerificationContext(v1WithStatement), rootControl(v1WithStatement))).toBeNull()
    const v2Root = rootPacket([statement], NATIVE_VERIFICATION_PACKET_SCHEMA_V2)
    expect(parseNativeVerificationPacket(createNativeVerificationContext(v2Root), rootControl(v2Root))).toEqual(v2Root)
    const v2WithoutStatement = rootPacket([{ referenceId: "root-fact", kind: "tool_result", summary: "Owned facts." }], NATIVE_VERIFICATION_PACKET_SCHEMA_V2)
    expect(parseNativeVerificationPacket(createNativeVerificationContext(v2WithoutStatement), rootControl(v2WithoutStatement))).toBeNull()
    const v2Child = { ...basePacket, schemaVersion: NATIVE_VERIFICATION_PACKET_SCHEMA_V2, evidence: [statement] }
    expect(parseNativeVerificationPacket(createNativeVerificationContext(v2Child), control(v2Child))).toBeNull()
    expect(parseNativeVerificationPacket(createNativeVerificationContext(rootPacket([
      { ...statement, referenceId: "user-self-attestation:short" },
    ], NATIVE_VERIFICATION_PACKET_SCHEMA_V2)), rootControl(rootPacket([
      { ...statement, referenceId: "user-self-attestation:short" },
    ], NATIVE_VERIFICATION_PACKET_SCHEMA_V2)))).toBeNull()
    expect(parseNativeVerificationPacket(createNativeVerificationContext(rootPacket([
      { ...statement, kind: "tool_result" },
    ], NATIVE_VERIFICATION_PACKET_SCHEMA_V2)), rootControl(rootPacket([
      { ...statement, kind: "tool_result" },
    ], NATIVE_VERIFICATION_PACKET_SCHEMA_V2)))).toBeNull()
  })

  it("preserves complete multibyte and escaped user statements under the v2 canonical bound", () => {
    const answer = "🙂".repeat(10_000) + "\u0000".repeat(10_000)
    const summary = JSON.stringify({ question: "What is your preference?", answer })
    const packet = rootPacket([{ referenceId: selfReference, kind: NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND, summary }], NATIVE_VERIFICATION_PACKET_SCHEMA_V2)
    const encoded = canonicalNativeVerificationJson(packet)
    expect(Buffer.byteLength(summary, "utf8")).toBeGreaterThan(8 * 1024)
    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(256 * 1024)
    expect(parseNativeVerificationPacket(createNativeVerificationContext(packet), rootControl(packet))).toEqual(packet)
    expect(JSON.parse(parseNativeVerificationPacket(createNativeVerificationContext(packet), rootControl(packet))!.evidence[0]!.summary).answer).toBe(answer)
  })

  it("keeps ordinary v2 evidence at 8 KiB and rejects oversized answer summaries or aggregate packets", () => {
    const oversizedOrdinary = rootPacket([
      { referenceId: selfReference, kind: NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND, summary: "complete answer" },
      { referenceId: "root-fact", kind: "tool_result", summary: "x".repeat(8 * 1024 + 1) },
    ], NATIVE_VERIFICATION_PACKET_SCHEMA_V2)
    expect(parseNativeVerificationPacket(createNativeVerificationContext(oversizedOrdinary), rootControl(oversizedOrdinary))).toBeNull()
    const oversizedAnswer = rootPacket([
      { referenceId: selfReference, kind: NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND, summary: "x".repeat(256 * 1024 + 1) },
    ], NATIVE_VERIFICATION_PACKET_SCHEMA_V2)
    expect(parseNativeVerificationPacket(createNativeVerificationContext(oversizedAnswer), rootControl(rootPacket([
      { referenceId: selfReference, kind: NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND, summary: "complete answer" },
    ], NATIVE_VERIFICATION_PACKET_SCHEMA_V2)))).toBeNull()
    const aggregate = rootPacket(["a", "b"].map(digest => ({ referenceId: `user-self-attestation:${digest.repeat(64)}`,
      kind: NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND, summary: "x".repeat(128 * 1024),
    })), NATIVE_VERIFICATION_PACKET_SCHEMA_V2)
    const aggregateBinding = rootControl(rootPacket([
      { referenceId: `user-self-attestation:${"a".repeat(64)}`, kind: NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND, summary: "complete answer" },
    ], NATIVE_VERIFICATION_PACKET_SCHEMA_V2))
    expect(Buffer.byteLength(JSON.stringify(aggregate), "utf8")).toBeGreaterThan(256 * 1024)
    expect(() => canonicalNativeVerificationJson(aggregate)).toThrow("native_verification_value_too_large")
    expect(parseNativeVerificationPacket(createNativeVerificationContext(aggregate), aggregateBinding)).toBeNull()
    const tooMany = rootPacket(Array.from({ length: 33 }, (_, index) => ({
      referenceId: `user-self-attestation:${String(index).padStart(64, "0")}`, kind: NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND, summary: "complete answer",
    })), NATIVE_VERIFICATION_PACKET_SCHEMA_V2)
    expect(parseNativeVerificationPacket(createNativeVerificationContext(tooMany), rootControl(tooMany))).toBeNull()
  })
})
