import { Buffer } from "node:buffer"
import {
  SPONSORSHIP_OBSERVATION_SCHEMA, SPONSORSHIP_OBSERVATION_REVIEW_SCHEMA,
  parseSponsorshipObservation, sponsorshipCitationDigest, sponsorshipClaimDigest,
  type SponsorshipObservation, type SponsorshipObservationBinding, type SponsorshipObservationSourceContext,
} from "./sponsorship-observation-contract.js"
import { canonicalNativeVerificationJson, digestNativeVerificationValue, type NativeVerificationControl, type NativeVerificationPacket } from "./native-verification-contract.js"
import { parseNativeVerificationReport } from "./native-verification-report.js"
import { sponsorshipQuoteMatchesTargetScope, type SponsorshipReviewPacket } from "./sponsorship-review-packet.js"

type Row = Record<string, unknown>
const MAX_PRIVATE_PROOF_BYTES = 32 * 1024

function record(value: unknown): Row | undefined {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return undefined } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Row : undefined } catch { return undefined }
}
function exact(value: unknown, keys: readonly string[]): Row | undefined {
  const parsed = record(value)
  if (!parsed) return undefined
  const own = Reflect.ownKeys(parsed)
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) return undefined
  return keys.every(key => Object.hasOwn(parsed, key)) ? parsed : undefined
}
function privateDigest(value: unknown): string { return `sha256:${digestNativeVerificationValue(value)}` }

/** Maps only exact Reviewer verdict/citation identities; all uncertainty stays inconclusive. */
export function readSponsorshipReviewObservation(input: Readonly<{
  taskId: string; status: string; attemptCount: number; failureReason: string | null; interruptRequestedAt: unknown
  result: unknown; qualityGateResult: unknown; qualityGateResultOversize?: boolean
  control: NativeVerificationControl; packet: NativeVerificationPacket; source: SponsorshipReviewPacket
}>): SponsorshipObservation | null {
  const { control, packet, source } = input
  if (control.target.kind !== "sponsorship_source" || control.controlTaskId !== input.taskId
    || control.target.rootAttemptCount !== source.target.rootAttemptCount || input.status !== "completed"
    || input.failureReason !== null || input.interruptRequestedAt !== null || input.qualityGateResultOversize === true
    || !Number.isSafeInteger(input.attemptCount) || input.attemptCount < 1
    || canonicalNativeVerificationJson(control.target) !== canonicalNativeVerificationJson(source.target)
    || canonicalNativeVerificationJson(packet) === "" || input.result === null) return null
  const result = exact(input.result, ["status", "stepCount", "toolCallCount"])
  if (!result || result.status !== "completed" || !Number.isSafeInteger(result.stepCount) || Number(result.stepCount) < 0
    || result.toolCallCount !== 0) return null
  let proofBytes: number
  try { proofBytes = Buffer.byteLength(canonicalNativeVerificationJson(input.qualityGateResult), "utf8") } catch { return null }
  if (proofBytes > MAX_PRIVATE_PROOF_BYTES) return null
  const report = parseNativeVerificationReport(input.qualityGateResult, control, packet, input.attemptCount)
  if (!report || report.target.kind !== "sponsorship_source") return null

  const available = report.criteria.find(item => item.criterionId === "criterion-1")
  const unavailable = report.criteria.find(item => item.criterionId === "criterion-2")
  if (!available || !unavailable) return null
  const allReferences = report.criteria.flatMap(item => item.evidenceReferenceIds)
  let claim: Extract<SponsorshipObservation, { status: "explicit" }> ["claim"] | undefined
  let selectedReference: string | undefined
  if (available.disposition === "passed" && available.reasonCode === "meets_criterion"
    && unavailable.disposition === "failed" && unavailable.reasonCode === "does_not_meet_criterion"
    && available.evidenceReferenceIds.length === 1 && unavailable.evidenceReferenceIds.length === 0
    && allReferences.length === 1) {
    claim = { kind: "work_visa_sponsorship", polarity: "available", scope: "same_role", countryCode: source.binding.targetCountryCode! }
    selectedReference = available.evidenceReferenceIds[0]
  } else if (unavailable.disposition === "passed" && unavailable.reasonCode === "meets_criterion"
    && available.disposition === "failed" && available.reasonCode === "does_not_meet_criterion"
    && unavailable.evidenceReferenceIds.length === 1 && available.evidenceReferenceIds.length === 0
    && allReferences.length === 1) {
    claim = { kind: "work_visa_sponsorship", polarity: "unavailable", scope: "same_role", countryCode: source.binding.targetCountryCode! }
    selectedReference = unavailable.evidenceReferenceIds[0]
  }
  const segment = selectedReference ? source.citationByReference.get(selectedReference) : undefined
  const evidence = selectedReference ? packet.evidence.find(item => item.referenceId === selectedReference) : undefined
  const sourceContext: SponsorshipObservationSourceContext = {
    source: source.sourceContext.source, sourceUrl: source.sourceContext.sourceUrl, company: source.sourceContext.company,
    role: source.sourceContext.role, location: source.sourceContext.location,
    descriptionExcerpt: source.sourceContext.description, descriptionExcerptStartByte: 0,
  }
  const binding: SponsorshipObservationBinding = source.binding
  if (!claim || !segment || !evidence || evidence.kind !== "saved_job_listing_description_segment"
    || !sponsorshipQuoteMatchesTargetScope(segment.quote, source.sourceContext.role, claim.countryCode)) {
    const raw = { schemaVersion: SPONSORSHIP_OBSERVATION_SCHEMA, status: "inconclusive", reason: "interpretation_unverified",
      binding, sourceContext }
    return parseSponsorshipObservation(raw, { binding, sourceContext, sourceFields: { description: source.sourceContext.description } })
  }
  const citation = { field: "description" as const, startByte: segment.startByte, endByte: segment.endByte, quote: segment.quote }
  const trustedReviewProof = {
    schemaVersion: SPONSORSHIP_OBSERVATION_REVIEW_SCHEMA, disposition: "passed" as const,
    reviewerTaskAttemptDigest: privateDigest({ taskId: input.taskId, attemptCount: input.attemptCount,
      controlOperationId: control.controlOperationId, rootAttemptCount: control.target.rootAttemptCount,
      sourceBindingDigest: control.target.sourceBindingDigest }),
    reviewerResultDigest: privateDigest(report), bindingDigest: binding.bindingDigest,
    sourceReceiptDigest: binding.sourceReceiptDigest!, materialDigest: binding.materialDigest!, roleDigest: binding.roleDigest,
    countryCode: binding.targetCountryCode!, claimDigest: sponsorshipClaimDigest(binding, claim),
    citationDigest: sponsorshipCitationDigest(binding, citation),
  }
  const raw = { schemaVersion: SPONSORSHIP_OBSERVATION_SCHEMA, status: "explicit", binding, claim, citation, sourceContext,
    reviewProof: trustedReviewProof }
  return parseSponsorshipObservation(raw, { binding, sourceContext, sourceFields: { description: source.sourceContext.description }, trustedReviewProof })
}
