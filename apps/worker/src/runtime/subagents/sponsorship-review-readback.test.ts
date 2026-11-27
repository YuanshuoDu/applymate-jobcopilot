import { describe, expect, it } from "vitest"
import {
  NATIVE_VERIFICATION_CONTROL_SCHEMA, NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA, NATIVE_VERIFICATION_PACKET_SCHEMA,
  canonicalNativeVerificationJson, digestNativeVerificationValue,
  type NativeVerificationControl, type NativeVerificationPacket,
} from "./native-verification-contract.js"
import { attachNativeVerificationReport } from "./native-verification-report.js"
import { buildSponsorshipReviewPacket } from "./sponsorship-review-packet.js"
import { readSponsorshipReviewObservation } from "./sponsorship-review-readback.js"

const DIGEST = `sha256:${"a".repeat(64)}`
const taskId = "subagent-123e4567-e89b-42d3-a456-426614174000"

function setup(description = "For this Backend Engineer role in Ireland, work visa sponsorship is available.",
  targetCountryCode = "IE", role = "Backend Engineer") {
  const source = buildSponsorshipReviewPacket({ userId: "owner", sessionId: "session", turnId: "turn", rootTaskId: "root",
    rootAttemptCount: 1, scoutTaskId: "subagent-123e4567-e89b-42d3-a456-426614174001", scoutAttempt: 1,
    scoutResultDigest: DIGEST, jobId: "job-1", sourceReceiptDigest: DIGEST, materialDigest: DIGEST,
    targetCountryCode, job: { id: "job-1", company: "Example Ltd", role, location: "Dublin",
      source: "greenhouse", url: "https://user:secret@jobs.example.test/role?token=private#fragment",
      description } })!
  const controlOperationId = `native-verification-${"b".repeat(48)}`
  const packet: NativeVerificationPacket = { schemaVersion: NATIVE_VERIFICATION_PACKET_SCHEMA, controlOperationId,
    controlTaskId: taskId, goal: source.content.goal, criteria: source.content.criteria, target: source.content.target,
    evidence: source.content.evidence }
  const control: NativeVerificationControl = { schemaVersion: NATIVE_VERIFICATION_CONTROL_SCHEMA, controlOperationId,
    controlTaskId: taskId, owner: { userId: "owner", sessionId: "session", turnId: "turn", rootTaskId: "root", parentTaskId: "root" },
    target: source.target, goalDigest: digestNativeVerificationValue(packet.goal), criteriaDigest: digestNativeVerificationValue(packet.criteria),
    evidencePacketDigest: digestNativeVerificationValue(packet) }
  return { source, packet, control }
}

function resultFor(source: ReturnType<typeof setup>["source"], packet: NativeVerificationPacket, control: NativeVerificationControl,
  verdicts: readonly Readonly<{ disposition: "passed" | "failed" | "uncertain"; reasonCode: "meets_criterion" | "does_not_meet_criterion" | "evidence_missing" | "evidence_conflict" | "ambiguous" | "unsupported_claim"; evidenceReferenceIds: readonly string[] }>[],
  overrides: Record<string, unknown> = {}) {
  const report = attachNativeVerificationReport(control, 1, {
    schemaVersion: NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA,
    criteria: verdicts.map((item, index) => ({ criterionId: `criterion-${index + 1}`, ...item })),
  })!
  return readSponsorshipReviewObservation({ taskId, status: "completed", attemptCount: 1, failureReason: null,
    interruptRequestedAt: null, result: { status: "completed", stepCount: 1, toolCallCount: 0 },
    qualityGateResult: report, control, packet, source, ...overrides })
}

describe("private sponsorship review readback", () => {
  it("accepts one exact saved-description segment only when one criterion passes and the other explicitly does not", () => {
    const { source, packet, control } = setup()
    const citationRef = packet.evidence[0]!.referenceId
    const observation = resultFor(source, packet, control, [
      { disposition: "passed", reasonCode: "meets_criterion", evidenceReferenceIds: [citationRef] },
      { disposition: "failed", reasonCode: "does_not_meet_criterion", evidenceReferenceIds: [] },
    ])
    expect(observation).toMatchObject({ status: "explicit", claim: { polarity: "available", countryCode: "IE" },
      citation: { field: "description", quote: expect.stringContaining("Ireland") },
      reviewProof: { disposition: "passed", bindingDigest: source.binding.bindingDigest } })
    expect(source.sourceContext.sourceUrl).toBe("https://jobs.example.test/role")
    expect(canonicalNativeVerificationJson(observation)).not.toMatch(/secret|token=private|#fragment/u)
    expect(canonicalNativeVerificationJson(observation)).not.toContain("controlTaskId")
  })

  it("keeps omissions, uncertainty, conflicting criteria, and multiple references inconclusive", () => {
    const { source, packet, control } = setup()
    const ref = packet.evidence[0]!.referenceId
    const cases = [
      [{ disposition: "failed", reasonCode: "does_not_meet_criterion", evidenceReferenceIds: [] }, { disposition: "failed", reasonCode: "does_not_meet_criterion", evidenceReferenceIds: [] }],
      [{ disposition: "passed", reasonCode: "meets_criterion", evidenceReferenceIds: [ref] }, { disposition: "passed", reasonCode: "meets_criterion", evidenceReferenceIds: [ref] }],
      [{ disposition: "passed", reasonCode: "meets_criterion", evidenceReferenceIds: [ref] }, { disposition: "uncertain", reasonCode: "ambiguous", evidenceReferenceIds: [] }],
      [{ disposition: "passed", reasonCode: "meets_criterion", evidenceReferenceIds: [ref] }, { disposition: "failed", reasonCode: "does_not_meet_criterion", evidenceReferenceIds: [ref] }],
    ] as const
    for (const verdicts of cases) expect(resultFor(source, packet, control, verdicts)).toMatchObject({ status: "inconclusive", reason: "interpretation_unverified" })
  })

  it("rejects the generic target reference as a citation even when the native report parser accepts it", () => {
    const { source, packet, control } = setup()
    const observation = resultFor(source, packet, control, [
      { disposition: "passed", reasonCode: "meets_criterion", evidenceReferenceIds: [packet.target.referenceId] },
      { disposition: "failed", reasonCode: "does_not_meet_criterion", evidenceReferenceIds: [] },
    ])
    expect(observation).toMatchObject({ status: "inconclusive", reason: "interpretation_unverified" })
  })

  it("rejects a mapped reference when its packet evidence kind is not a saved listing description segment", () => {
    const { source, packet, control } = setup()
    const referenceId = packet.evidence[0]!.referenceId
    expect(source.citationByReference.has(referenceId)).toBe(true)
    const alteredPacket: NativeVerificationPacket = {
      ...packet,
      evidence: packet.evidence.map(item => item.referenceId === referenceId ? { ...item, kind: "job_metadata" } : item),
    }
    const alteredControl: NativeVerificationControl = {
      ...control,
      evidencePacketDigest: digestNativeVerificationValue(alteredPacket),
    }
    const observation = resultFor(source, alteredPacket, alteredControl, [
      { disposition: "passed", reasonCode: "meets_criterion", evidenceReferenceIds: [referenceId] },
      { disposition: "failed", reasonCode: "does_not_meet_criterion", evidenceReferenceIds: [] },
    ])
    expect(observation).toMatchObject({ status: "inconclusive", reason: "interpretation_unverified" })
  })

  it.each([
    ["generic sponsorship wording", "Visa sponsorship is available."],
    ["a different country", "For this Backend Engineer role in the United Kingdom, work visa sponsorship is available."],
    ["a different role", "For this Data Engineer role in Ireland, work visa sponsorship is available."],
  ])("keeps %s inconclusive even when the native criteria verdict is explicit", (_label, description) => {
    const { source, packet, control } = setup(description)
    const ref = packet.evidence[0]!.referenceId
    const observation = resultFor(source, packet, control, [
      { disposition: "passed", reasonCode: "meets_criterion", evidenceReferenceIds: [ref] },
      { disposition: "failed", reasonCode: "does_not_meet_criterion", evidenceReferenceIds: [] },
    ])
    expect(observation).toMatchObject({ status: "inconclusive", reason: "interpretation_unverified" })
  })

  it.each([
    ["IN must not match the ordinary word in", "For this Backend Engineer role, sponsorship is available in Ireland.", "IN", "Backend Engineer"],
    ["IT must not match the pronoun It", "It may be available for this Backend Engineer role.", "IT", "Backend Engineer"],
    ["Georgia must be disambiguated as a country", "For this Backend Engineer role in Georgia, sponsorship is available.", "GE", "Backend Engineer"],
    ["uppercase role acronym must not match a lowercase pronoun", "It sponsorship is available for this role in Ireland.", "IE", "IT"],
  ])("keeps ambiguous scope inconclusive: %s", (_label, description, countryCode, role) => {
    const { source, packet, control } = setup(description, countryCode, role)
    const ref = packet.evidence[0]!.referenceId
    const observation = resultFor(source, packet, control, [
      { disposition: "passed", reasonCode: "meets_criterion", evidenceReferenceIds: [ref] },
      { disposition: "failed", reasonCode: "does_not_meet_criterion", evidenceReferenceIds: [] },
    ])
    expect(observation).toMatchObject({ status: "inconclusive", reason: "interpretation_unverified" })
  })

  it("accepts only an explicitly disambiguated Georgia country name", () => {
    const description = "For this Backend Engineer role in Georgia (country), work visa sponsorship is available."
    const { source, packet, control } = setup(description, "GE")
    const ref = packet.evidence[0]!.referenceId
    const observation = resultFor(source, packet, control, [
      { disposition: "passed", reasonCode: "meets_criterion", evidenceReferenceIds: [ref] },
      { disposition: "failed", reasonCode: "does_not_meet_criterion", evidenceReferenceIds: [] },
    ])
    expect(observation).toMatchObject({ status: "explicit", claim: { countryCode: "GE", polarity: "available" } })
  })

  it("rejects incomplete, interrupted, wrong-attempt, and oversize private reports", () => {
    const { source, packet, control } = setup()
    const ref = packet.evidence[0]!.referenceId
    const validVerdicts = [
      { disposition: "passed" as const, reasonCode: "meets_criterion" as const, evidenceReferenceIds: [ref] },
      { disposition: "failed" as const, reasonCode: "does_not_meet_criterion" as const, evidenceReferenceIds: [] },
    ]
    expect(resultFor(source, packet, control, validVerdicts, { interruptRequestedAt: new Date() })).toBeNull()
    expect(resultFor(source, packet, control, validVerdicts, { attemptCount: 2 })).toBeNull()
    expect(resultFor(source, packet, control, validVerdicts, { qualityGateResultOversize: true })).toBeNull()
    expect(resultFor(source, packet, control, validVerdicts, { result: { status: "completed", nativeVerificationReport: {} } })).toBeNull()
  })

  it("rejects reserved/non-ISO country values", () => {
    const { source } = setup()
    const sourceInput = { userId: "owner", sessionId: "session", turnId: "turn", rootTaskId: "root", rootAttemptCount: 1,
      scoutTaskId: "subagent-123e4567-e89b-42d3-a456-426614174001", scoutAttempt: 1, scoutResultDigest: DIGEST,
      jobId: "job-1", sourceReceiptDigest: DIGEST, materialDigest: DIGEST,
      targetCountryCode: "ZZ", job: { id: "job-1", ...source.sourceContext } }
    expect(buildSponsorshipReviewPacket(sourceInput)).toBeNull()
  })
})
