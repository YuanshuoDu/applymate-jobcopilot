import { describe, expect, it } from "vitest"
import type { NativeVerificationPacket } from "./native-verification-contract.js"
import { nativeVerificationControlContentMatches } from "./native-verification-pg-request.js"

describe("native verification durable request replay identity", () => {
  it("ignores root review feedback in stable packet replay while retaining it in the persisted packet", () => {
    const packet: NativeVerificationPacket = {
      schemaVersion: "agent-harness.v2.native-verifier-packet.v1", controlOperationId: "operation-1", controlTaskId: "control-1",
      goal: "Meet the original goal", criteria: [{ criterionId: "criterion-1", requirement: "Use source facts" }],
      target: { kind: "root_goal", candidateDigest: "a".repeat(64), referenceId: "candidate:1", candidateText: "answer" },
      evidence: [
        { referenceId: "history:1", kind: "review_history", summary: "prior review was negative" },
        { referenceId: "graph:1", kind: "graph_history", summary: "persisted graph facts" },
      ],
    }
    const replay = { goal: packet.goal, criteria: packet.criteria, target: packet.target, evidence: [
      { referenceId: "history:2", kind: "review_history", summary: "different prior feedback" }, packet.evidence[1]!,
    ] }
    expect(nativeVerificationControlContentMatches(packet, replay)).toBe(true)
    expect(nativeVerificationControlContentMatches(packet, { ...replay, evidence: [replay.evidence[0]!,
      { referenceId: "graph:1", kind: "graph_history", summary: "changed source facts" }] })).toBe(false)
    expect(packet.evidence[0]?.summary).toContain("prior review was negative")
  })

  it("does not ignore child packet evidence changes during replay validation", () => {
    const packet = {
      schemaVersion: "agent-harness.v2.native-verifier-packet.v1", controlOperationId: "operation-2", controlTaskId: "control-2",
      goal: "Review child", criteria: [{ criterionId: "criterion-1", requirement: "Use exact tool output" }],
      target: { kind: "child", taskId: "child-1", attempt: 1, resultDigest: "b".repeat(64), referenceId: "target:1", resultText: "{}" },
      evidence: [{ referenceId: "tool:1", kind: "tool_result", summary: "persisted fact" }],
    } as NativeVerificationPacket
    expect(nativeVerificationControlContentMatches(packet, { goal: packet.goal, criteria: packet.criteria,
      target: packet.target, evidence: [{ referenceId: "tool:1", kind: "tool_result", summary: "changed fact" }] })).toBe(false)
  })
})
