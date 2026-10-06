import { describe, expect, it } from "vitest"

import { NATIVE_VERIFICATION_REPORT_SCHEMA } from "../subagents/native-verification-contract.js"
import { projectNativeVerificationResult } from "./native-verification-feedback-projection.js"

function report(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: NATIVE_VERIFICATION_REPORT_SCHEMA,
    controlOperationId: "verify-operation-1",
    controlTaskId: "subagent-12345678-1234-4234-9234-123456789012",
    controlAttempt: 1,
    owner: {
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: null,
    },
    target: { kind: "root_goal", candidateDigest: "a".repeat(64), childBindingSetDigest: "b".repeat(64) },
    goalDigest: "c".repeat(64),
    criteriaDigest: "d".repeat(64),
    evidencePacketDigest: "e".repeat(64),
    disposition: "passed",
    criteria: [{
      criterionId: "criterion-1", disposition: "passed", reasonCode: "meets_criterion", evidenceReferenceIds: ["target-ref-1"],
    }],
    ...overrides,
  }
}

describe("native verification feedback projection", () => {
  it("keeps only bounded criterion feedback and drops server proof bindings", () => {
    const result = projectNativeVerificationResult({
      status: "completed", stepCount: 2, summary: "The reviewed result is present.", nativeVerificationReport: report(),
    })

    expect(result).toEqual({
      status: "completed", stepCount: 2, summary: "The reviewed result is present.",
      nativeVerificationFeedback: {
        disposition: "passed",
        criteria: [{
          criterionId: "criterion-1", disposition: "passed", reasonCode: "meets_criterion", evidenceReferenceIds: ["target-ref-1"],
        }],
      },
    })
    const serialized = JSON.stringify(result)
    for (const secret of ["nativeVerificationReport", "controlTaskId", "controlOperationId", "controlAttempt", "owner", "candidateDigest", "Digest", "witness"]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it("preserves failure feedback without turning it into an authority receipt", () => {
    const failed = report({
      disposition: "failed",
      criteria: [{
        criterionId: "criterion-1", disposition: "failed", reasonCode: "does_not_meet_criterion", evidenceReferenceIds: [],
      }],
    })
    expect(projectNativeVerificationResult({ nativeVerificationReport: failed })).toEqual({
      nativeVerificationFeedback: {
        disposition: "failed",
        criteria: [{
          criterionId: "criterion-1", disposition: "failed", reasonCode: "does_not_meet_criterion", evidenceReferenceIds: [],
        }],
      },
    })
  })

  it("suppresses only typed self-attestation references, including a report that cites only a private answer", () => {
    const privateReference = `user-self-attestation:${"f".repeat(64)}`
    const withPrivateAndOrdinary = projectNativeVerificationResult({ nativeVerificationReport: report({
      criteria: [{ criterionId: "criterion-1", disposition: "passed", reasonCode: "meets_criterion",
        evidenceReferenceIds: ["target-ref-1", privateReference] }],
    }) })
    expect(withPrivateAndOrdinary).toEqual({ nativeVerificationFeedback: {
      disposition: "passed", criteria: [{ criterionId: "criterion-1", disposition: "passed", reasonCode: "meets_criterion",
        evidenceReferenceIds: ["target-ref-1"] }],
    } })

    const malformedNamespace = projectNativeVerificationResult({ nativeVerificationReport: report({
      criteria: [{ criterionId: "criterion-1", disposition: "passed", reasonCode: "meets_criterion",
        evidenceReferenceIds: ["user-self-attestation:bad"] }],
    }) })
    expect(malformedNamespace).toMatchObject({ nativeVerificationFeedback: { criteria: [{ evidenceReferenceIds: ["user-self-attestation:bad"] }] } })

    const privateOnly = projectNativeVerificationResult({ nativeVerificationReport: report({
      criteria: [{ criterionId: "criterion-1", disposition: "passed", reasonCode: "meets_criterion",
        evidenceReferenceIds: [privateReference] }],
    }) })
    expect(privateOnly).toEqual({ nativeVerificationFeedback: {
      disposition: "passed", criteria: [{ criterionId: "criterion-1", disposition: "passed", reasonCode: "meets_criterion",
        evidenceReferenceIds: [] }],
    } })
    const serialized = JSON.stringify({ withPrivateAndOrdinary, privateOnly })
    expect(serialized).not.toContain(privateReference)
  })

  it("omits malformed reports instead of leaking them or inventing feedback", () => {
    const valid = report()
    const invalidReports = [
      { ...valid, extraPrivateField: "server-only" },
      { ...valid, criteria: [{ ...valid.criteria[0], reasonCode: "freeform explanation" }] },
      { ...valid, criteria: [{ ...valid.criteria[0], evidenceReferenceIds: ["unknown", "unknown"] }] },
      { ...valid, disposition: "failed" },
      { ...valid, criteria: new Array(1) },
      { ...valid, controlOperationId: "invalid id" },
    ]
    for (const nativeVerificationReport of invalidReports) {
      expect(projectNativeVerificationResult({ status: "completed", nativeVerificationReport })).toEqual({ status: "completed" })
    }
  })

  it("leaves ordinary role, artifact, and repair result shapes untouched", () => {
    const result = { roleResult: { summary: "done" }, artifactRefs: ["artifact-1"], repair: { status: "applied" } }
    expect(projectNativeVerificationResult(result)).toBe(result)
  })

  it("does not invoke a report accessor and omits it", () => {
    let read = false
    const result = { status: "completed" }
    Object.defineProperty(result, "nativeVerificationReport", {
      enumerable: true,
      get() { read = true; return report() },
    })
    expect(projectNativeVerificationResult(result)).toEqual({ status: "completed" })
    expect(read).toBe(false)
  })
})
