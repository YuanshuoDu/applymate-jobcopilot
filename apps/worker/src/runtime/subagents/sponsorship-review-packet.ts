import { Buffer } from "node:buffer"
import { isIso3166Alpha2CountryCode } from "@jobcopilot/shared"
import { sponsorshipRoleDigest, type SponsorshipObservationBinding } from "./sponsorship-observation-contract.js"
import { canonicalNativeVerificationJson, digestNativeVerificationValue,
  type NativeVerificationTargetBinding } from "./native-verification-contract.js"
import type { NativeVerificationPacketContent } from "./native-verification-pg-evidence.js"

type Row = Record<string, unknown>
export const SPONSORSHIP_REVIEW_MAX_DESCRIPTION_BYTES = 8 * 1024
const MAX_CITATION_SEGMENT_BYTES = 900

export type SponsorshipReviewSource = Readonly<{
  userId: string
  sessionId: string
  turnId: string
  rootTaskId: string
  rootAttemptCount: number
  scoutTaskId: string
  scoutAttempt: number
  scoutResultDigest: string
  jobId: string
  sourceReceiptDigest: string
  materialDigest: string
  targetCountryCode: string
  job: Row
}>

export type SponsorshipReviewPacket = Readonly<{
  target: Extract<NativeVerificationTargetBinding, { kind: "sponsorship_source" }>
  binding: SponsorshipObservationBinding
  content: NativeVerificationPacketContent
  sourceContext: Readonly<{ source: string; sourceUrl: string; company: string; role: string; location: string | null; description: string }>
  citationByReference: ReadonlyMap<string, Readonly<{ startByte: number; endByte: number; quote: string }>>
}>

function digest(value: unknown): string { return `sha256:${digestNativeVerificationValue(value)}` }
function text(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes
}
function nullableText(value: unknown, maxBytes: number): value is string | null {
  return value === null || typeof value === "string" && Buffer.byteLength(value, "utf8") <= maxBytes
}
function sourceReferenceUrl(value: unknown): string | undefined {
  if (!text(value, 4096)) return undefined
  try {
    const parsed = new URL(value)
    return (parsed.protocol === "https:" || parsed.protocol === "http:")
      ? `${parsed.origin}${parsed.pathname}` : undefined
  } catch { return undefined }
}

/** Resolves a display label only after the selected code passes the pinned ISO 3166 table. */
export function sponsorshipCountryName(countryCode: string): string | null {
  if (!isIso3166Alpha2CountryCode(countryCode)) return null
  try {
    const name = new Intl.DisplayNames(["en"], { type: "region" }).of(countryCode)
    return name && name !== countryCode ? name : null
  } catch { return null }
}

function exactPhrasePresent(textValue: string, phrase: string, caseSensitive = false): boolean {
  const normalizedText = textValue.normalize("NFKC")
  const normalizedPhrase = phrase.normalize("NFKC").trim().replace(/\s+/gu, " ")
  if (!normalizedPhrase) return false
  const escaped = normalizedPhrase.split(" ").map(token => token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("\\s+")
  const haystack = caseSensitive ? normalizedText : normalizedText.toLocaleLowerCase("en")
  const needle = caseSensitive ? escaped : escaped.toLocaleLowerCase("en")
  try { return new RegExp(`(^|[^\\p{L}\\p{N}])${needle}(?=$|[^\\p{L}\\p{N}])`, "u").test(haystack) } catch { return false }
}

/** Listing text must name this exact role and selected ISO country; job location is never consulted. */
export function sponsorshipQuoteMatchesTargetScope(quote: string, role: string, countryCode: string): boolean {
  const countryName = sponsorshipCountryName(countryCode)
  const shortUppercaseRoleToken = /(^|[^\p{L}\p{N}])[A-Z]{1,3}(?=$|[^\p{L}\p{N}])/u.test(role.normalize("NFKC"))
  const roleMatches = exactPhrasePresent(quote, role, shortUppercaseRoleToken)
  if (!countryName || !roleMatches) return false
  if (countryCode === "GE") {
    return ["Georgia (country)", "Georgia (the country)", "Georgia, the country", "country of Georgia", "Republic of Georgia"]
      .some(label => exactPhrasePresent(quote, label))
  }
  return exactPhrasePresent(quote, countryName)
}

/** Partitions the whole description; an over-limit source never becomes a partial negative review. */
function citationSegments(description: string): readonly Readonly<{ startByte: number; endByte: number; quote: string }>[] {
  const segments: { startByte: number; endByte: number; quote: string }[] = []
  let quote = "", startByte = 0, byteOffset = 0
  for (const character of description) {
    const size = Buffer.byteLength(character, "utf8")
    if (quote && Buffer.byteLength(quote, "utf8") + size > MAX_CITATION_SEGMENT_BYTES) {
      segments.push({ startByte, endByte: byteOffset, quote })
      startByte = byteOffset
      quote = ""
    }
    quote += character
    byteOffset += size
  }
  if (quote) segments.push({ startByte, endByte: byteOffset, quote })
  return segments
}

export function buildSponsorshipReviewPacket(source: SponsorshipReviewSource): SponsorshipReviewPacket | null {
  const { job } = source
  if (![source.userId, source.sessionId, source.turnId, source.rootTaskId, source.scoutTaskId, source.jobId].every(value => text(value, 256))
    || !Number.isSafeInteger(source.rootAttemptCount) || source.rootAttemptCount < 1
    || !Number.isSafeInteger(source.scoutAttempt) || source.scoutAttempt < 1
    || !isIso3166Alpha2CountryCode(source.targetCountryCode)
    || !/^sha256:[a-f0-9]{64}$/.test(source.scoutResultDigest)
    || !/^sha256:[a-f0-9]{64}$/.test(source.sourceReceiptDigest)
    || !/^sha256:[a-f0-9]{64}$/.test(source.materialDigest)
    || job.id !== source.jobId || !text(job.company, 500) || !text(job.role, 500)
    || !nullableText(job.location, 500) || !nullableText(job.description, SPONSORSHIP_REVIEW_MAX_DESCRIPTION_BYTES)
    || !text(job.source, 80) || !sourceReferenceUrl(job.url)) return null
  const description = job.description
  if (!description || Buffer.byteLength(description, "utf8") === 0) return null
  const url = sourceReferenceUrl(job.url)
  if (!url) return null
  const roleDigest = sponsorshipRoleDigest(job.role)
  const binding = {
    bindingDigest: digest({ schemaVersion: "agent-harness.v2.job-sponsorship-review-binding.v1", userId: source.userId,
      sessionId: source.sessionId, turnId: source.turnId, rootTaskId: source.rootTaskId,
      rootAttemptCount: source.rootAttemptCount, scoutTaskId: source.scoutTaskId, scoutAttempt: source.scoutAttempt,
      scoutResultDigest: source.scoutResultDigest, jobId: source.jobId, sourceReceiptDigest: source.sourceReceiptDigest,
      materialDigest: source.materialDigest, roleDigest, targetCountryCode: source.targetCountryCode }),
    sourceReceiptDigest: source.sourceReceiptDigest, materialDigest: source.materialDigest, roleDigest,
    targetCountryCode: source.targetCountryCode,
  } satisfies SponsorshipObservationBinding
  const target: Extract<NativeVerificationTargetBinding, { kind: "sponsorship_source" }> = {
    kind: "sponsorship_source", jobId: source.jobId, scoutTaskId: source.scoutTaskId, scoutAttempt: source.scoutAttempt,
    scoutResultDigest: source.scoutResultDigest, sourceReceiptDigest: source.sourceReceiptDigest,
    materialDigest: source.materialDigest, roleDigest, targetCountryCode: source.targetCountryCode,
    rootAttemptCount: source.rootAttemptCount,
    sourceBindingDigest: digest({ ...binding, jobId: source.jobId, scoutTaskId: source.scoutTaskId,
      scoutAttempt: source.scoutAttempt, scoutResultDigest: source.scoutResultDigest, rootAttemptCount: source.rootAttemptCount }),
  }
  const sourceContext = { source: job.source, sourceUrl: url, company: job.company, role: job.role,
    location: job.location, description }
  const sourceText = canonicalNativeVerificationJson({ ...sourceContext, targetCountryCode: source.targetCountryCode,
    sourceRef: "saved_job_listing" })
  const targetReferenceId = `sponsorship-source:${target.sourceBindingDigest.slice(7, 39)}`
  const evidence: { referenceId: string; kind: string; summary: string }[] = []
  const citationByReference = new Map<string, { startByte: number; endByte: number; quote: string }>()
  for (const segment of citationSegments(description)) {
    const referenceId = `sponsorship-citation:${digest({ bindingDigest: binding.bindingDigest, ...segment }).slice(7, 39)}`
    if (citationByReference.has(referenceId)) return null
    citationByReference.set(referenceId, segment)
    evidence.push({ referenceId, kind: "saved_job_listing_description_segment",
      summary: JSON.stringify({ sourceRef: "saved_job_listing.description", ...segment }) })
  }
  const countryName = sponsorshipCountryName(source.targetCountryCode)
  if (!countryName) return null
  return {
    target, binding, sourceContext, citationByReference,
    content: {
      goal: `Assess only what this saved Job listing explicitly states about work visa sponsorship for the same listed role in ${countryName} (${source.targetCountryCode}). This is a statement about listing text at review time, not employer policy or a guarantee.`,
      criteria: [
        { criterionId: "criterion-1", requirement: `The saved listing description explicitly says sponsorship is available for this same role in ${countryName} (${source.targetCountryCode}). The description citation itself must identify this country and same role; the user's target and the listing location are not proof.` },
        { criterionId: "criterion-2", requirement: `The saved listing description explicitly says sponsorship is unavailable for this same role in ${countryName} (${source.targetCountryCode}). The description citation itself must identify this country and same role; the user's target and the listing location are not proof.` },
      ],
      target: { kind: "sponsorship_source", sourceBindingDigest: target.sourceBindingDigest,
        sourceTextDigest: digest(sourceText), referenceId: targetReferenceId, sourceText },
      evidence,
    },
  }
}
