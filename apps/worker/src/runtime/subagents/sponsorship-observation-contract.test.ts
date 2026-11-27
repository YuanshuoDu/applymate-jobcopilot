import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"

import {
  SPONSORSHIP_OBSERVATION_REVIEW_SCHEMA, SPONSORSHIP_OBSERVATION_SCHEMA,
  parseSponsorshipObservation, parseSponsorshipObservationPublicFrame, sponsorshipCitationDigest, sponsorshipClaimDigest, sponsorshipRoleDigest,
  toSponsorshipObservationModelFrame, toSponsorshipObservationPublicFrame,
  type SponsorshipObservation, type SponsorshipObservationBinding, type SponsorshipObservationCitation,
  type SponsorshipObservationClaim, type SponsorshipObservationExpectation, type SponsorshipObservationReviewProof,
  type SponsorshipObservationSourceContext,
} from "./sponsorship-observation-contract.js"

const d = (value: string) => "sha256:" + value.repeat(64).slice(0, 64)
const description = "€ Visa sponsorship is available for this role in Ireland."
const quote = "Visa sponsorship is available for this role in Ireland."
const quoteStart = Buffer.byteLength("€ ", "utf8")
const binding: SponsorshipObservationBinding = {
  bindingDigest: d("a"), sourceReceiptDigest: d("b"), materialDigest: d("c"),
  roleDigest: sponsorshipRoleDigest("Software Engineer"), targetCountryCode: "IE",
}
const sourceContext: SponsorshipObservationSourceContext = {
  source: "greenhouse", sourceUrl: "https://jobs.example", company: "Example Ltd",
  role: "Software Engineer", location: "Dublin, Ireland", descriptionExcerpt: description, descriptionExcerptStartByte: 0,
}
const claim: SponsorshipObservationClaim = {
  kind: "work_visa_sponsorship", polarity: "available", scope: "same_role", countryCode: "IE",
}
const citation: SponsorshipObservationCitation = {
  field: "description", startByte: quoteStart, endByte: quoteStart + Buffer.byteLength(quote, "utf8"), quote,
}

function reviewerProof(currentBinding = binding, currentClaim = claim, currentCitation = citation): SponsorshipObservationReviewProof {
  return {
    schemaVersion: SPONSORSHIP_OBSERVATION_REVIEW_SCHEMA, disposition: "passed",
    reviewerTaskAttemptDigest: d("d"), reviewerResultDigest: d("e"),
    bindingDigest: currentBinding.bindingDigest, sourceReceiptDigest: currentBinding.sourceReceiptDigest!,
    materialDigest: currentBinding.materialDigest!, roleDigest: currentBinding.roleDigest,
    countryCode: currentBinding.targetCountryCode!, claimDigest: sponsorshipClaimDigest(currentBinding, currentClaim),
    citationDigest: sponsorshipCitationDigest(currentBinding, currentCitation),
  }
}

function expectation(overrides: Partial<SponsorshipObservationExpectation> = {}): SponsorshipObservationExpectation {
  return { binding, sourceContext, sourceFields: { description }, ...overrides }
}

function inconclusive(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: SPONSORSHIP_OBSERVATION_SCHEMA, status: "inconclusive", reason: "interpretation_unverified",
    binding, sourceContext, ...overrides,
  }
}

function explicit(overrides: Record<string, unknown> = {}) {
  const proof = reviewerProof()
  return {
    schemaVersion: SPONSORSHIP_OBSERVATION_SCHEMA, status: "explicit", binding,
    claim, citation, sourceContext, reviewProof: proof, ...overrides,
  }
}

describe("sponsorship observation contract", () => {
  it("keeps unreviewed source context inconclusive and labels it untrusted for the model", () => {
    const parsed = parseSponsorshipObservation(inconclusive(), expectation())!
    expect(parsed.status).toBe("inconclusive")
    const model = toSponsorshipObservationModelFrame(parsed)
    expect(model).toMatchObject({
      status: "inconclusive", reason: "interpretation_unverified",
      sourceContext: { trustBoundary: "untrusted_saved_job_listing", role: "Software Engineer", location: "Dublin, Ireland", descriptionExcerpt: description },
    })
    expect(JSON.stringify(model)).not.toContain(binding.bindingDigest)
    expect(JSON.stringify(model)).not.toContain(binding.materialDigest!)
  })

  it("keeps public output minimal and strips unverified source text and private bindings", () => {
    const parsed = parseSponsorshipObservation(inconclusive(), expectation())!
    const publicFrame = toSponsorshipObservationPublicFrame(parsed)
    expect(publicFrame).toEqual({
      schemaVersion: "agent-harness.v2.job-sponsorship-observation-public.v1",
      status: "inconclusive", reason: "interpretation_unverified",
    })
    expect(JSON.stringify(publicFrame)).not.toContain(description)
    expect(JSON.stringify(publicFrame)).not.toContain("jobs.example")
    expect(JSON.stringify(publicFrame)).not.toContain(binding.bindingDigest)
  })

  it("parses only closed public statuses and permits citation only on explicit output", () => {
    const unverified = parseSponsorshipObservation(inconclusive(), expectation())!
    const inconclusiveFrame = toSponsorshipObservationPublicFrame(unverified)
    expect(parseSponsorshipObservationPublicFrame(inconclusiveFrame)).toEqual(inconclusiveFrame)
    expect(parseSponsorshipObservationPublicFrame({ ...inconclusiveFrame, citation: { sourceRef: "saved_job_listing.description", quote } })).toBeNull()
    const verified = parseSponsorshipObservation(explicit(), expectation({ trustedReviewProof: reviewerProof() }))!
    const explicitFrame = toSponsorshipObservationPublicFrame(verified, { includeVerifiedCitation: true })
    expect(parseSponsorshipObservationPublicFrame(explicitFrame)).toEqual(explicitFrame)
    expect(parseSponsorshipObservationPublicFrame({ ...explicitFrame, materialDigest: binding.materialDigest })).toBeNull()
    expect(parseSponsorshipObservationPublicFrame({ ...explicitFrame, citation: { sourceRef: "foreign", quote } })).toBeNull()
  })

  it("requires a fixed not-performed reason and no source receipt for not_checked", () => {
    const noReadBinding = { ...binding, sourceReceiptDigest: null, materialDigest: null }
    const raw = { schemaVersion: SPONSORSHIP_OBSERVATION_SCHEMA, status: "not_checked", reason: "not_performed", binding: noReadBinding }
    expect(parseSponsorshipObservation(raw, expectation({ binding: noReadBinding }))).toMatchObject({ status: "not_checked", reason: "not_performed" })
    expect(parseSponsorshipObservation({ ...raw, reason: "no_sponsorship_found" }, expectation({ binding: noReadBinding }))).toBeNull()
    expect(parseSponsorshipObservation({ ...raw, sourceContext }, expectation({ binding: noReadBinding }))).toBeNull()
  })

  it("keeps unavailable reasons closed and never assigns a polarity", () => {
    const unavailableBinding = { ...binding, materialDigest: null }
    const raw = { schemaVersion: SPONSORSHIP_OBSERVATION_SCHEMA, status: "unavailable", reason: "duplicate_receipt", binding: unavailableBinding }
    const parsed = parseSponsorshipObservation(raw, expectation({ binding: unavailableBinding }))!
    expect(parsed).toMatchObject({ status: "unavailable", reason: "duplicate_receipt" })
    expect(toSponsorshipObservationPublicFrame(parsed)).not.toHaveProperty("claim")
    expect(parseSponsorshipObservation({ ...raw, reason: "maybe" }, expectation({ binding: unavailableBinding }))).toBeNull()
  })

  it("accepts explicit only with exact quote and the separately trusted matching Reviewer proof", () => {
    const proof = reviewerProof()
    const parsed = parseSponsorshipObservation(explicit(), expectation({ trustedReviewProof: proof }))!
    expect(parsed.status).toBe("explicit")
    if (parsed.status !== "explicit") throw new Error("expected explicit observation")
    expect(parsed.claim).toEqual(claim)
    expect(parsed.citation).toEqual(citation)
    expect(parsed.reviewProof).toEqual(proof)
    expect(toSponsorshipObservationModelFrame(parsed)).toMatchObject({
      status: "explicit", reviewBasis: "independently_reviewed_same_role_same_country",
      citation: { sourceRef: "saved_job_listing.description", quote },
    })
    expect(toSponsorshipObservationPublicFrame(parsed)).not.toHaveProperty("citation")
    expect(toSponsorshipObservationPublicFrame(parsed, { includeVerifiedCitation: true })).toMatchObject({
      status: "explicit", claim, citation: { sourceRef: "saved_job_listing.description", quote },
    })
  })

  it("rejects model-supplied or stale Reviewer proof when the trusted proof is absent or differs", () => {
    const forged = explicit()
    expect(parseSponsorshipObservation(forged, expectation())).toBeNull()
    const trusted = reviewerProof()
    const mismatched = { ...trusted, reviewerResultDigest: d("f") }
    expect(parseSponsorshipObservation(forged, expectation({ trustedReviewProof: mismatched }))).toBeNull()
    expect(parseSponsorshipObservation(explicit({ reviewProof: { ...trusted, bindingDigest: d("f") } }),
      expectation({ trustedReviewProof: trusted }))).toBeNull()
  })

  it.each([
    ["different country", { ...claim, countryCode: "GB" }],
    ["employer-level scope", { ...claim, scope: "employer_general" }],
    ["different claim kind", { ...claim, kind: "employer_immigration_policy" }],
  ])("rejects explicit claim with %s", (_name, changedClaim) => {
    const changedProof = reviewerProof(binding, changedClaim as SponsorshipObservationClaim, citation)
    expect(parseSponsorshipObservation(explicit({ claim: changedClaim, reviewProof: changedProof }),
      expectation({ trustedReviewProof: reviewerProof() }))).toBeNull()
  })

  it("rejects wrong Job/source binding, stale material, and missing canonical country", () => {
    expect(parseSponsorshipObservation(inconclusive(), expectation({ binding: { ...binding, bindingDigest: d("f") } }))).toBeNull()
    expect(parseSponsorshipObservation(inconclusive(), expectation({ binding: { ...binding, materialDigest: d("f") } }))).toBeNull()
    const noCountry = { ...binding, targetCountryCode: null }
    expect(parseSponsorshipObservation(explicit({ binding: noCountry }), expectation({ binding: noCountry, trustedReviewProof: reviewerProof() }))).toBeNull()
  })

  it("rejects wrong, repeated, out-of-context, or non-UTF-8-aligned citation spans", () => {
    const proof = reviewerProof()
    const duplicateDescription = description + " " + quote
    const duplicateContext = { ...sourceContext, descriptionExcerpt: duplicateDescription }
    const duplicateCitation = { ...citation, startByte: Buffer.byteLength(description + " ", "utf8"), endByte: Buffer.byteLength(description + " ", "utf8") + Buffer.byteLength(quote, "utf8") }
    const duplicateProof = reviewerProof(binding, claim, duplicateCitation)
    expect(parseSponsorshipObservation(explicit({ citation: duplicateCitation, reviewProof: duplicateProof }),
      expectation({ sourceContext: duplicateContext, sourceFields: { description: duplicateDescription }, trustedReviewProof: duplicateProof }))).toBeNull()
    expect(parseSponsorshipObservation(explicit({ citation: { ...citation, quote: "No sponsorship is available." } }),
      expectation({ trustedReviewProof: proof }))).toBeNull()
    expect(parseSponsorshipObservation(explicit({ citation: { ...citation, startByte: 1, endByte: 1 + Buffer.byteLength(quote, "utf8") } }),
      expectation({ trustedReviewProof: proof }))).toBeNull()
    expect(parseSponsorshipObservation(explicit({ citation: { ...citation, startByte: 1, endByte: 2 } }),
      expectation({ trustedReviewProof: proof }))).toBeNull()
  })

  it("rejects source context not bound to the exact redacted description and role", () => {
    expect(parseSponsorshipObservation(inconclusive({ sourceContext: { ...sourceContext, descriptionExcerpt: "other text" } }), expectation())).toBeNull()
    const wrongRole = { ...sourceContext, role: "Different role" }
    expect(parseSponsorshipObservation(inconclusive({ sourceContext: wrongRole }),
      expectation({ sourceContext: wrongRole }))).toBeNull()
    expect(parseSponsorshipObservation(inconclusive({ sourceContext: { ...sourceContext, sourceUrl: "https://jobs.example/listing?id=private" } }), expectation())).toBeNull()
  })

  it("rejects open schemas and accessor-backed input without invoking the accessor", () => {
    expect(parseSponsorshipObservation({ ...inconclusive(), jobId: "job-private" }, expectation())).toBeNull()
    let called = false
    const raw = Object.defineProperty({}, "status", { enumerable: true, get() { called = true; return "inconclusive" } })
    Object.assign(raw, { schemaVersion: SPONSORSHIP_OBSERVATION_SCHEMA, reason: "interpretation_unverified", binding, sourceContext })
    expect(parseSponsorshipObservation(raw, expectation())).toBeNull()
    expect(called).toBe(false)
  })
})
