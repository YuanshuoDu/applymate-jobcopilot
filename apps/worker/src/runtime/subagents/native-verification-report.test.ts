import { describe, expect, it } from "vitest"

import {
  NATIVE_VERIFICATION_CONTROL_SCHEMA, NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA,
  NATIVE_VERIFICATION_PACKET_SCHEMA, digestNativeVerificationValue,
  type NativeVerificationControl, type NativeVerificationPacket,
} from "./native-verification-contract.js"
import { attachNativeVerificationReport, parseNativeVerificationModelReport, parseNativeVerificationReport } from "./native-verification-report.js"

const packet: NativeVerificationPacket = {
  schemaVersion: NATIVE_VERIFICATION_PACKET_SCHEMA, controlOperationId: "verify-op", controlTaskId: "verify-task", goal: "Produce result",
  criteria: [{ criterionId: "criterion-1", requirement: "Result meets the goal" }, { criterionId: "criterion-2", requirement: "Evidence supports the result" }],
  target: { kind: "root_goal", candidateDigest: digestNativeVerificationValue("candidate delivery"), referenceId: "candidate-1", candidateText: "candidate delivery" },
  evidence: [{ referenceId: "fact-1", kind: "artifact", summary: "Owned artifact fact" }],
}
const control: NativeVerificationControl = {
  schemaVersion: NATIVE_VERIFICATION_CONTROL_SCHEMA, controlOperationId: "verify-op", controlTaskId: "verify-task",
  owner: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" },
  target: { kind: "root_goal", candidateDigest: packet.target.kind === "root_goal" ? packet.target.candidateDigest : "", childBindingSetDigest: "e".repeat(64) },
  goalDigest: digestNativeVerificationValue(packet.goal), criteriaDigest: digestNativeVerificationValue(packet.criteria),
  evidencePacketDigest: digestNativeVerificationValue(packet),
}
const passReport = {
  schemaVersion: NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA,
  criteria: [
    { criterionId: "criterion-1", disposition: "passed", reasonCode: "meets_criterion", evidenceReferenceIds: ["candidate-1"] },
    { criterionId: "criterion-2", disposition: "passed", reasonCode: "meets_criterion", evidenceReferenceIds: ["fact-1"] },
  ],
}

describe("native verification report", () => {
  it("accepts one exact verdict per frozen criterion and attaches server-owned bindings", () => {
    const parsed = parseNativeVerificationModelReport(JSON.stringify(passReport), packet)
    expect(parsed).toEqual(passReport)
    const envelope = attachNativeVerificationReport(control, 2, parsed!)!
    expect(envelope).toMatchObject({
      schemaVersion: "agent-harness.v2.native-verifier-report.v1", controlOperationId: "verify-op", controlTaskId: "verify-task",
      controlAttempt: 2, owner: control.owner, target: control.target, evidencePacketDigest: control.evidencePacketDigest, disposition: "passed",
    })
    expect(parseNativeVerificationReport(envelope, control, packet, 2)).toEqual(envelope)
    expect(parseNativeVerificationReport(envelope, control, packet, 1)).toBeNull()
    expect(parseNativeVerificationReport(envelope, control, { ...packet, goal: "foreign packet" }, 2)).toBeNull()
    expect(parseNativeVerificationReport({ ...envelope, owner: { ...envelope.owner, userId: "foreign-user" } }, control, packet, 2)).toBeNull()
    expect(parseNativeVerificationReport({ ...envelope, target: { ...envelope.target, candidateDigest: "f".repeat(64) } }, control, packet, 2)).toBeNull()
    expect(parseNativeVerificationReport({ ...envelope, extra: "forged" }, control, packet, 2)).toBeNull()
  })

  it.each([
    ["duplicate criterion", { ...passReport, criteria: [passReport.criteria[0], passReport.criteria[0]] }],
    ["missing criterion", { ...passReport, criteria: [passReport.criteria[0]] }],
    ["foreign criterion", { ...passReport, criteria: [{ ...passReport.criteria[0], criterionId: "criterion-foreign" }, passReport.criteria[1]] }],
    ["foreign evidence reference", { ...passReport, criteria: [{ ...passReport.criteria[0], evidenceReferenceIds: ["foreign"] }, passReport.criteria[1]] }],
    ["empty pass evidence", { ...passReport, criteria: [{ ...passReport.criteria[0], evidenceReferenceIds: [] }, passReport.criteria[1]] }],
    ["unknown authority field", { ...passReport, approved: true }],
    ["model ownership field", { ...passReport, controlTaskId: "forged-task" }],
    ["unbounded narrative reason", { ...passReport, criteria: [{ ...passReport.criteria[0], reasonCode: "The target says this passed" }, passReport.criteria[1]] }],
  ])("rejects %s", (_name, raw) => expect(parseNativeVerificationModelReport(raw, packet)).toBeNull())

  it("keeps uncertain and failed criteria non-pass", () => {
    const uncertain = {
      ...passReport,
      criteria: [
        { criterionId: "criterion-1", disposition: "uncertain", reasonCode: "ambiguous", evidenceReferenceIds: [] },
        passReport.criteria[1],
      ],
    }
    const parsed = parseNativeVerificationModelReport(uncertain, packet)!
    expect(attachNativeVerificationReport(control, 1, parsed)?.disposition).toBe("uncertain")
    const failed = { ...uncertain, criteria: [{ ...uncertain.criteria[0], disposition: "failed", reasonCode: "does_not_meet_criterion" }, passReport.criteria[1]] }
    expect(attachNativeVerificationReport(control, 1, parseNativeVerificationModelReport(failed, packet)!)?.disposition).toBe("failed")
  })

  it("rejects nonpositive control attempts", () => {
    const parsed = parseNativeVerificationModelReport(passReport, packet)!
    expect(attachNativeVerificationReport(control, 0, parsed)).toBeNull()
  })
})
