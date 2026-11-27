import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { isIso3166Alpha2CountryCode } from "@jobcopilot/shared"

export const SPONSORSHIP_OBSERVATION_SCHEMA = "agent-harness.v2.job-sponsorship-observation.v1" as const
export const SPONSORSHIP_OBSERVATION_PUBLIC_SCHEMA = "agent-harness.v2.job-sponsorship-observation-public.v1" as const
export const SPONSORSHIP_OBSERVATION_REVIEW_SCHEMA = "agent-harness.v2.job-sponsorship-review-proof.v1" as const
export const SPONSORSHIP_OBSERVATION_MAX_CONTEXT_BYTES = 8 * 1024
export const SPONSORSHIP_OBSERVATION_MAX_CITATION_BYTES = 1024

type Digest = string
type CountryCode = string

export type SponsorshipObservationBinding = Readonly<{
  bindingDigest: Digest
  sourceReceiptDigest: Digest | null
  materialDigest: Digest | null
  roleDigest: Digest
  targetCountryCode: CountryCode | null
}>

export type SponsorshipObservationSourceContext = Readonly<{
  source: string
  sourceUrl: string
  company: string
  role: string
  location: string | null
  descriptionExcerpt: string
  descriptionExcerptStartByte: number
}>

export type SponsorshipObservationReviewProof = Readonly<{
  schemaVersion: typeof SPONSORSHIP_OBSERVATION_REVIEW_SCHEMA
  disposition: "passed"
  reviewerTaskAttemptDigest: Digest
  reviewerResultDigest: Digest
  bindingDigest: Digest
  sourceReceiptDigest: Digest
  materialDigest: Digest
  roleDigest: Digest
  countryCode: CountryCode
  claimDigest: Digest
  citationDigest: Digest
}>

export type SponsorshipObservationClaim = Readonly<{
  kind: "work_visa_sponsorship"
  polarity: "available" | "unavailable"
  scope: "same_role"
  countryCode: CountryCode
}>

export type SponsorshipObservationCitation = Readonly<{
  field: "description"
  startByte: number
  endByte: number
  quote: string
}>

type ObservationBase = Readonly<{
  schemaVersion: typeof SPONSORSHIP_OBSERVATION_SCHEMA
  binding: SponsorshipObservationBinding
}>

export type SponsorshipObservation =
  | (ObservationBase & Readonly<{ status: "not_checked"; reason: "not_performed" }>)
  | (ObservationBase & Readonly<{ status: "unavailable"; reason: "read_failed" | "source_missing" | "invalid_receipt" | "duplicate_receipt" | "source_drift" | "wrong_job" }>)
  | (ObservationBase & Readonly<{
      status: "inconclusive"
      reason: "interpretation_unverified"
      sourceContext: SponsorshipObservationSourceContext
    }>)
  | (ObservationBase & Readonly<{
      status: "explicit"
      claim: SponsorshipObservationClaim
      citation: SponsorshipObservationCitation
      sourceContext: SponsorshipObservationSourceContext
      reviewProof: SponsorshipObservationReviewProof
    }>)

export type SponsorshipObservationPublicCitation = Readonly<{
  sourceRef: "saved_job_listing.description"
  quote: string
}>

export type SponsorshipObservationPublicFrame =
  | Readonly<{ schemaVersion: typeof SPONSORSHIP_OBSERVATION_PUBLIC_SCHEMA; status: "not_checked"; reason: "not_performed" }>
  | Readonly<{ schemaVersion: typeof SPONSORSHIP_OBSERVATION_PUBLIC_SCHEMA; status: "unavailable"; reason: Extract<SponsorshipObservation, { status: "unavailable" }>["reason"] }>
  | Readonly<{ schemaVersion: typeof SPONSORSHIP_OBSERVATION_PUBLIC_SCHEMA; status: "inconclusive"; reason: "interpretation_unverified" }>
  | Readonly<{ schemaVersion: typeof SPONSORSHIP_OBSERVATION_PUBLIC_SCHEMA; status: "explicit"; claim: SponsorshipObservationClaim }>
  | Readonly<{ schemaVersion: typeof SPONSORSHIP_OBSERVATION_PUBLIC_SCHEMA; status: "explicit"; claim: SponsorshipObservationClaim; citation: SponsorshipObservationPublicCitation }>

export type SponsorshipObservationModelSourceContext = SponsorshipObservationSourceContext & Readonly<{
  trustBoundary: "untrusted_saved_job_listing"
}>

export type SponsorshipObservationModelFrame =
  | Readonly<{ schemaVersion: typeof SPONSORSHIP_OBSERVATION_SCHEMA; status: "not_checked"; reason: "not_performed" }>
  | Readonly<{ schemaVersion: typeof SPONSORSHIP_OBSERVATION_SCHEMA; status: "unavailable"; reason: Extract<SponsorshipObservation, { status: "unavailable" }>["reason"] }>
  | Readonly<{ schemaVersion: typeof SPONSORSHIP_OBSERVATION_SCHEMA; status: "inconclusive"; reason: "interpretation_unverified"; sourceContext: SponsorshipObservationModelSourceContext }>
  | Readonly<{
      schemaVersion: typeof SPONSORSHIP_OBSERVATION_SCHEMA
      status: "explicit"
      claim: SponsorshipObservationClaim
      citation: SponsorshipObservationPublicCitation
      sourceContext: SponsorshipObservationModelSourceContext
      reviewBasis: "independently_reviewed_same_role_same_country"
    }>

export type SponsorshipObservationExpectation = Readonly<{
  binding: SponsorshipObservationBinding
  sourceContext?: SponsorshipObservationSourceContext
  sourceFields?: Readonly<{ description: string | null }>
  /** Supply only after independently revalidating the persisted Reviewer result. */
  trustedReviewProof?: SponsorshipObservationReviewProof
}>

const DIGEST = /^sha256:[a-f0-9]{64}$/
const SOURCE_CONTEXT_KEYS = "company,descriptionExcerpt,descriptionExcerptStartByte,location,role,source,sourceUrl"
const BINDING_KEYS = "bindingDigest,materialDigest,roleDigest,sourceReceiptDigest,targetCountryCode"
const REVIEW_KEYS = "bindingDigest,citationDigest,claimDigest,countryCode,disposition,materialDigest,reviewerResultDigest,reviewerTaskAttemptDigest,roleDigest,schemaVersion,sourceReceiptDigest"
const CLAIM_KEYS = "countryCode,kind,polarity,scope"
const CITATION_KEYS = "endByte,field,quote,startByte"
const UNAVAILABLE_REASONS = ["read_failed", "source_missing", "invalid_receipt", "duplicate_receipt", "source_drift", "wrong_job"] as const
type UnavailableReason = typeof UNAVAILABLE_REASONS[number]

type Row = Record<string, unknown>

function record(value: unknown): Row | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const prototype = Object.getPrototypeOf(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length > 0
      || Object.getOwnPropertyNames(value).length !== Object.keys(value).length
      || Object.values(descriptors).some(item => !item.enumerable || !("value" in item))) return undefined
    return value as Row
  } catch { return undefined }
}

function exact(value: unknown, keys: string): Row | undefined {
  const row = record(value)
  if (!row) return undefined
  const actual = Reflect.ownKeys(row)
  return actual.every(key => typeof key === "string") && actual.sort().join(",") === keys ? row : undefined
}

function text(value: unknown, maxBytes: number, allowEmpty = false): value is string {
  return typeof value === "string" && (allowEmpty || value.trim().length > 0)
    && Buffer.byteLength(value, "utf8") <= maxBytes && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)
}

function digest(value: unknown): value is Digest { return typeof value === "string" && DIGEST.test(value) }
function country(value: unknown): value is CountryCode { return isIso3166Alpha2CountryCode(value) }
function optionalCountry(value: unknown): value is CountryCode | null { return value === null || country(value) }
function safeOffset(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }

function parseBinding(value: unknown): SponsorshipObservationBinding | undefined {
  const row = exact(value, BINDING_KEYS)
  if (!row || !digest(row.bindingDigest) || !(row.sourceReceiptDigest === null || digest(row.sourceReceiptDigest))
    || !(row.materialDigest === null || digest(row.materialDigest)) || !digest(row.roleDigest)
    || !optionalCountry(row.targetCountryCode)) return undefined
  return {
    bindingDigest: row.bindingDigest, sourceReceiptDigest: row.sourceReceiptDigest,
    materialDigest: row.materialDigest, roleDigest: row.roleDigest, targetCountryCode: row.targetCountryCode,
  }
}

function normalizeSourceUrl(value: unknown): string | undefined {
  if (!text(value, 4096)) return undefined
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined
    parsed.username = ""
    parsed.password = ""
    parsed.search = ""
    parsed.hash = ""
    return `${parsed.origin}${parsed.pathname}`
  } catch { return undefined }
}

function byteSlice(value: string, startByte: number, endByte: number): string | undefined {
  if (!safeOffset(startByte) || !safeOffset(endByte) || endByte <= startByte) return undefined
  const bytes = Buffer.from(value, "utf8")
  if (endByte > bytes.length) return undefined
  const slice = bytes.subarray(startByte, endByte)
  const decoded = slice.toString("utf8")
  return Buffer.from(decoded, "utf8").equals(slice) ? decoded : undefined
}

function parseSourceContext(value: unknown, binding: SponsorshipObservationBinding, description: string | null): SponsorshipObservationSourceContext | undefined {
  const row = exact(value, SOURCE_CONTEXT_KEYS)
  if (!row) return undefined
  const source = row.source, sourceUrl = normalizeSourceUrl(row.sourceUrl), company = row.company, role = row.role
  const location = row.location, excerpt = row.descriptionExcerpt, start = row.descriptionExcerptStartByte
  if (!text(source, 80) || !sourceUrl || !text(company, 500) || !text(role, 500)
    || !(location === null || text(location, 500)) || !text(excerpt, SPONSORSHIP_OBSERVATION_MAX_CONTEXT_BYTES, true)
    || !safeOffset(start) || sponsorshipRoleDigest(role) !== binding.roleDigest) return undefined
  if (description === null) {
    if (excerpt !== "" || start !== 0) return undefined
  } else {
    const exactExcerpt = excerpt.length === 0 ? "" : byteSlice(description, start, start + Buffer.byteLength(excerpt, "utf8"))
    if (description.length > 0 && (!excerpt || exactExcerpt !== excerpt)) return undefined
    if (description.length === 0 && (excerpt !== "" || start !== 0)) return undefined
  }
  return {
    source, sourceUrl, company, role, location, descriptionExcerpt: excerpt, descriptionExcerptStartByte: start,
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  try { return canonicalJson(left) === canonicalJson(right) } catch { return false }
}

function canonicalJson(value: unknown): string {
  const visit = (item: unknown): unknown => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item
    if (typeof item === "number" && Number.isFinite(item)) return item
    if (Array.isArray(item)) return item.map(visit)
    const row = record(item)
    if (!row) throw new TypeError("sponsorship_value_not_json")
    return Object.fromEntries(Object.keys(row).sort().map(key => [key, visit(row[key])]))
  }
  return JSON.stringify(visit(value))
}

function hash(value: unknown): Digest {
  return "sha256:" + createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")
}

export function sponsorshipRoleDigest(role: string): Digest {
  return "sha256:" + createHash("sha256").update(role, "utf8").digest("hex")
}

export function sponsorshipClaimDigest(binding: SponsorshipObservationBinding, claim: SponsorshipObservationClaim): Digest {
  return hash({ schemaVersion: SPONSORSHIP_OBSERVATION_SCHEMA, binding, claim })
}

export function sponsorshipCitationDigest(binding: SponsorshipObservationBinding, citation: SponsorshipObservationCitation): Digest {
  return hash({ schemaVersion: SPONSORSHIP_OBSERVATION_SCHEMA, binding, citation })
}

function parseClaim(value: unknown, binding: SponsorshipObservationBinding): SponsorshipObservationClaim | undefined {
  const row = exact(value, CLAIM_KEYS)
  if (!row || row.kind !== "work_visa_sponsorship" || (row.polarity !== "available" && row.polarity !== "unavailable")
    || row.scope !== "same_role" || !country(row.countryCode) || row.countryCode !== binding.targetCountryCode) return undefined
  return { kind: "work_visa_sponsorship", polarity: row.polarity, scope: "same_role", countryCode: row.countryCode }
}

function parseCitation(value: unknown, binding: SponsorshipObservationBinding, description: string | null): SponsorshipObservationCitation | undefined {
  const row = exact(value, CITATION_KEYS)
  if (!row || row.field !== "description" || !safeOffset(row.startByte) || !safeOffset(row.endByte)
    || !text(row.quote, SPONSORSHIP_OBSERVATION_MAX_CITATION_BYTES) || row.endByte <= row.startByte
    || Buffer.byteLength(row.quote, "utf8") !== row.endByte - row.startByte || typeof description !== "string") return undefined
  const actual = byteSlice(description, row.startByte, row.endByte)
  if (actual !== row.quote || description.indexOf(row.quote) !== description.lastIndexOf(row.quote)
    || !binding.materialDigest) return undefined
  return { field: "description", startByte: row.startByte, endByte: row.endByte, quote: row.quote }
}

function parseReviewProof(value: unknown): SponsorshipObservationReviewProof | undefined {
  const row = exact(value, REVIEW_KEYS)
  if (!row || row.schemaVersion !== SPONSORSHIP_OBSERVATION_REVIEW_SCHEMA || row.disposition !== "passed"
    || !digest(row.reviewerTaskAttemptDigest) || !digest(row.reviewerResultDigest) || !digest(row.bindingDigest)
    || !digest(row.sourceReceiptDigest) || !digest(row.materialDigest) || !digest(row.roleDigest)
    || !country(row.countryCode) || !digest(row.claimDigest) || !digest(row.citationDigest)) return undefined
  return {
    schemaVersion: SPONSORSHIP_OBSERVATION_REVIEW_SCHEMA, disposition: "passed",
    reviewerTaskAttemptDigest: row.reviewerTaskAttemptDigest, reviewerResultDigest: row.reviewerResultDigest,
    bindingDigest: row.bindingDigest, sourceReceiptDigest: row.sourceReceiptDigest, materialDigest: row.materialDigest,
    roleDigest: row.roleDigest, countryCode: row.countryCode, claimDigest: row.claimDigest, citationDigest: row.citationDigest,
  }
}

function proofMatches(proof: SponsorshipObservationReviewProof, binding: SponsorshipObservationBinding,
  claim: SponsorshipObservationClaim, citation: SponsorshipObservationCitation): boolean {
  return binding.sourceReceiptDigest !== null && binding.materialDigest !== null && binding.targetCountryCode !== null
    && proof.bindingDigest === binding.bindingDigest && proof.sourceReceiptDigest === binding.sourceReceiptDigest
    && proof.materialDigest === binding.materialDigest && proof.roleDigest === binding.roleDigest
    && proof.countryCode === binding.targetCountryCode && proof.claimDigest === sponsorshipClaimDigest(binding, claim)
    && proof.citationDigest === sponsorshipCitationDigest(binding, citation)
}

/** Structural parser for already-verified public frames; it does not establish source provenance. */
export function parseSponsorshipObservationPublicFrame(value: unknown): SponsorshipObservationPublicFrame | null {
  const row = record(value)
  if (!row || row.schemaVersion !== SPONSORSHIP_OBSERVATION_PUBLIC_SCHEMA) return null
  if (row.status === "not_checked") {
    return exact(row, "reason,schemaVersion,status") && row.reason === "not_performed"
      ? { schemaVersion: SPONSORSHIP_OBSERVATION_PUBLIC_SCHEMA, status: "not_checked", reason: "not_performed" } : null
  }
  if (row.status === "unavailable") {
    if (!exact(row, "reason,schemaVersion,status") || !UNAVAILABLE_REASONS.includes(row.reason as UnavailableReason)) return null
    return { schemaVersion: SPONSORSHIP_OBSERVATION_PUBLIC_SCHEMA, status: "unavailable", reason: row.reason as UnavailableReason }
  }
  if (row.status === "inconclusive") {
    return exact(row, "reason,schemaVersion,status") && row.reason === "interpretation_unverified"
      ? { schemaVersion: SPONSORSHIP_OBSERVATION_PUBLIC_SCHEMA, status: "inconclusive", reason: "interpretation_unverified" } : null
  }
  if (row.status !== "explicit") return null
  const hasCitation = Object.hasOwn(row, "citation")
  if (!exact(row, hasCitation ? "citation,claim,schemaVersion,status" : "claim,schemaVersion,status")) return null
  const claim = exact(row.claim, CLAIM_KEYS)
  if (!claim || claim.kind !== "work_visa_sponsorship" || (claim.polarity !== "available" && claim.polarity !== "unavailable")
    || claim.scope !== "same_role" || !country(claim.countryCode)) return null
  const parsedClaim: SponsorshipObservationClaim = { kind: claim.kind, polarity: claim.polarity, scope: claim.scope, countryCode: claim.countryCode }
  if (hasCitation) {
    const citation = exact(row.citation, "quote,sourceRef")
    if (!citation || citation.sourceRef !== "saved_job_listing.description"
      || !text(citation.quote, SPONSORSHIP_OBSERVATION_MAX_CITATION_BYTES)) return null
    return { schemaVersion: SPONSORSHIP_OBSERVATION_PUBLIC_SCHEMA, status: "explicit", claim: parsedClaim,
      citation: { sourceRef: "saved_job_listing.description", quote: citation.quote } }
  }
  return { schemaVersion: SPONSORSHIP_OBSERVATION_PUBLIC_SCHEMA, status: "explicit", claim: parsedClaim }
}

/** Parses a server-built observation against current source and separately trusted Reviewer proof. */
export function parseSponsorshipObservation(value: unknown, expected: SponsorshipObservationExpectation): SponsorshipObservation | null {
  try {
    const root = record(value)
    const binding = root && parseBinding(root.binding)
    const expectedBinding = parseBinding(expected.binding)
    if (!root || !binding || !expectedBinding || root.schemaVersion !== SPONSORSHIP_OBSERVATION_SCHEMA
      || !sameJson(binding, expectedBinding)) return null
    if (root.status === "not_checked") {
      if (!exact(root, "binding,reason,schemaVersion,status") || root.reason !== "not_performed"
        || binding.sourceReceiptDigest !== null || binding.materialDigest !== null) return null
      return { schemaVersion: SPONSORSHIP_OBSERVATION_SCHEMA, status: "not_checked", reason: "not_performed", binding }
    }
    if (root.status === "unavailable") {
      if (!exact(root, "binding,reason,schemaVersion,status") || binding.materialDigest !== null
        || !["read_failed", "source_missing", "invalid_receipt", "duplicate_receipt", "source_drift", "wrong_job"].includes(String(root.reason))) return null
      return { schemaVersion: SPONSORSHIP_OBSERVATION_SCHEMA, status: "unavailable", reason: root.reason as Extract<SponsorshipObservation, { status: "unavailable" }>["reason"], binding }
    }
    if (root.status !== "inconclusive" && root.status !== "explicit") return null
    if (binding.sourceReceiptDigest === null || binding.materialDigest === null || !expected.sourceFields
      || !Object.hasOwn(expected.sourceFields, "description")) return null
    const description = expected.sourceFields.description
    if (description !== null && typeof description !== "string") return null
    const sourceContext = parseSourceContext(root.sourceContext, binding, description)
    const expectedSourceContext = parseSourceContext(expected.sourceContext, expectedBinding, description)
    if (!sourceContext || !expectedSourceContext || !sameJson(sourceContext, expectedSourceContext)) return null
    if (root.status === "inconclusive") {
      if (!exact(root, "binding,reason,schemaVersion,sourceContext,status") || root.reason !== "interpretation_unverified") return null
      return { schemaVersion: SPONSORSHIP_OBSERVATION_SCHEMA, status: "inconclusive", reason: "interpretation_unverified", binding, sourceContext }
    }
    if (!exact(root, "binding,citation,claim,reviewProof,schemaVersion,sourceContext,status")
      || binding.targetCountryCode === null) return null
    const claim = parseClaim(root.claim, binding)
    const citation = parseCitation(root.citation, binding, description)
    const reviewProof = parseReviewProof(root.reviewProof)
    const trustedReviewProof = parseReviewProof(expected.trustedReviewProof)
    if (!claim || !citation || !reviewProof || !trustedReviewProof || !sameJson(reviewProof, trustedReviewProof)
      || !proofMatches(reviewProof, binding, claim, citation)) return null
    const excerptEnd = sourceContext.descriptionExcerptStartByte + Buffer.byteLength(sourceContext.descriptionExcerpt, "utf8")
    if (citation.startByte < sourceContext.descriptionExcerptStartByte || citation.endByte > excerptEnd) return null
    return { schemaVersion: SPONSORSHIP_OBSERVATION_SCHEMA, status: "explicit", binding, claim, citation, sourceContext, reviewProof }
  } catch { return null }
}

/** Model context may include a bounded listing excerpt, explicitly labeled as untrusted source data. */
export function toSponsorshipObservationModelFrame(value: SponsorshipObservation): SponsorshipObservationModelFrame {
  if (value.status === "not_checked") return { schemaVersion: SPONSORSHIP_OBSERVATION_SCHEMA, status: "not_checked", reason: value.reason }
  if (value.status === "unavailable") return { schemaVersion: SPONSORSHIP_OBSERVATION_SCHEMA, status: "unavailable", reason: value.reason }
  const sourceContext: SponsorshipObservationModelSourceContext = { trustBoundary: "untrusted_saved_job_listing", ...value.sourceContext }
  if (value.status === "inconclusive") return {
    schemaVersion: SPONSORSHIP_OBSERVATION_SCHEMA, status: "inconclusive", reason: value.reason, sourceContext,
  }
  return {
    schemaVersion: SPONSORSHIP_OBSERVATION_SCHEMA, status: "explicit", claim: value.claim,
    citation: { sourceRef: "saved_job_listing.description", quote: value.citation.quote }, sourceContext,
    reviewBasis: "independently_reviewed_same_role_same_country",
  }
}

/** Public/browser output omits source text and private bindings; citations are opt-in and explicit-only. */
export function toSponsorshipObservationPublicFrame(value: SponsorshipObservation,
  options: Readonly<{ includeVerifiedCitation?: boolean }> = {}): SponsorshipObservationPublicFrame {
  if (value.status === "not_checked") return { schemaVersion: SPONSORSHIP_OBSERVATION_PUBLIC_SCHEMA, status: value.status, reason: value.reason }
  if (value.status === "unavailable") return {
    schemaVersion: SPONSORSHIP_OBSERVATION_PUBLIC_SCHEMA, status: value.status, reason: value.reason,
  }
  if (value.status === "inconclusive") return {
    schemaVersion: SPONSORSHIP_OBSERVATION_PUBLIC_SCHEMA, status: value.status, reason: value.reason,
  }
  const claim = value.claim
  if (options.includeVerifiedCitation === true) return {
    schemaVersion: SPONSORSHIP_OBSERVATION_PUBLIC_SCHEMA, status: "explicit", claim,
    citation: { sourceRef: "saved_job_listing.description", quote: value.citation.quote },
  }
  return { schemaVersion: SPONSORSHIP_OBSERVATION_PUBLIC_SCHEMA, status: "explicit", claim }
}
