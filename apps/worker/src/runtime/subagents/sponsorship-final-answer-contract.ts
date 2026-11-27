import { isIso3166Alpha2CountryCode } from "@jobcopilot/shared"

export const SPONSORSHIP_FINAL_ANSWER_SCHEMA = "agent-harness.v2.sponsorship-final-answer.v1" as const
/** Trusted code brands the only terminal guard allowed to complete a country-scoped sponsorship Turn. */
export const SPONSORSHIP_FINAL_ANSWER_TERMINAL_GUARD: unique symbol = Symbol("sponsorship_final_answer_terminal_guard")
const HASH = /^sha256:[a-f0-9]{64}$/
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export type SponsorshipFinalAnswerOutcome = Readonly<{
  jobId: string
  role: string
  status: "explicit" | "inconclusive"
  polarity?: "available" | "unavailable"
  reviewerTaskId: string
  reviewerAttempt: number
  reviewBindingDigest: string
}>

export type SponsorshipFinalAnswerBinding = Readonly<{
  schemaVersion: typeof SPONSORSHIP_FINAL_ANSWER_SCHEMA
  rootTaskId: string
  rootAttemptCount: number
  candidateStepId: string
  targetCountryCode: string
  outcomes: readonly SponsorshipFinalAnswerOutcome[]
}>

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return undefined
    if (Object.getOwnPropertySymbols(value).length) return undefined
    return value as Record<string, unknown>
  } catch { return undefined }
}

function exact(row: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(row)
  return own.length === keys.length && own.every(key => typeof key === "string" && keys.includes(key))
    && keys.every(key => Object.hasOwn(row, key))
}

function identifier(value: unknown): value is string { return typeof value === "string" && IDENTIFIER.test(value) }
function role(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 500 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

export function parseSponsorshipFinalAnswerBinding(value: unknown): SponsorshipFinalAnswerBinding | null {
  const row = record(value)
  if (!row || !exact(row, ["candidateStepId", "outcomes", "rootAttemptCount", "rootTaskId", "schemaVersion", "targetCountryCode"])
    || row.schemaVersion !== SPONSORSHIP_FINAL_ANSWER_SCHEMA || !identifier(row.rootTaskId) || !identifier(row.candidateStepId)
    || !Number.isSafeInteger(row.rootAttemptCount) || Number(row.rootAttemptCount) < 1
    || typeof row.targetCountryCode !== "string" || !isIso3166Alpha2CountryCode(row.targetCountryCode)
    || !Array.isArray(row.outcomes) || row.outcomes.length > 8 || Reflect.ownKeys(row.outcomes).length !== row.outcomes.length + 1) return null
  const seenJobs = new Set<string>(), seenReviewers = new Set<string>(), outcomes: SponsorshipFinalAnswerOutcome[] = []
  for (let index = 0; index < row.outcomes.length; index += 1) {
    if (!Object.hasOwn(row.outcomes, index)) return null
    const entry = record(row.outcomes[index])
    if (!entry || (entry.status === "explicit"
      ? !exact(entry, ["jobId", "polarity", "reviewBindingDigest", "reviewerAttempt", "reviewerTaskId", "role", "status"])
      : !exact(entry, ["jobId", "reviewBindingDigest", "reviewerAttempt", "reviewerTaskId", "role", "status"]))
      || !identifier(entry.jobId) || seenJobs.has(entry.jobId) || !role(entry.role)
      || !identifier(entry.reviewerTaskId) || seenReviewers.has(entry.reviewerTaskId)
      || !Number.isSafeInteger(entry.reviewerAttempt) || Number(entry.reviewerAttempt) < 1
      || typeof entry.reviewBindingDigest !== "string" || !HASH.test(entry.reviewBindingDigest)) return null
    if (entry.status === "explicit") {
      if (entry.polarity !== "available" && entry.polarity !== "unavailable") return null
      outcomes.push({ jobId: entry.jobId, role: entry.role, status: "explicit", polarity: entry.polarity,
        reviewerTaskId: entry.reviewerTaskId, reviewerAttempt: Number(entry.reviewerAttempt), reviewBindingDigest: entry.reviewBindingDigest })
    } else if (entry.status === "inconclusive") {
      outcomes.push({ jobId: entry.jobId, role: entry.role, status: "inconclusive", reviewerTaskId: entry.reviewerTaskId,
        reviewerAttempt: Number(entry.reviewerAttempt), reviewBindingDigest: entry.reviewBindingDigest })
    } else return null
    seenJobs.add(entry.jobId); seenReviewers.add(entry.reviewerTaskId)
  }
  return { schemaVersion: SPONSORSHIP_FINAL_ANSWER_SCHEMA, rootTaskId: row.rootTaskId,
    rootAttemptCount: Number(row.rootAttemptCount), candidateStepId: row.candidateStepId,
    targetCountryCode: row.targetCountryCode, outcomes }
}

export function sameSponsorshipFinalAnswerBinding(left: unknown, right: unknown): boolean {
  const a = parseSponsorshipFinalAnswerBinding(left), b = parseSponsorshipFinalAnswerBinding(right)
  return !!a && !!b && JSON.stringify(a) === JSON.stringify(b)
}

/** Renders only server-validated listing interpretations; no quote, URL, Job ID, or proof leaves the private binding. */
export function renderSponsorshipFinalAnswer(value: unknown, countryName: (code: string) => string | null): readonly string[] | null {
  const binding = parseSponsorshipFinalAnswerBinding(value)
  if (!binding) return null
  const country = countryName(binding.targetCountryCode)
  if (!country) return null
  if (binding.outcomes.length === 0) return [
    `Sponsorship assessment for ${country}: no current completed listing review was available, so availability is unknown. An absent review is not evidence that sponsorship is unavailable.`,
  ]
  return binding.outcomes.map(outcome => outcome.status === "explicit"
    ? `Saved listing assessment for "${outcome.role}" in ${country}: the listing explicitly states that work visa sponsorship is ${outcome.polarity}. This describes listing text at review time, not employer policy or a guarantee.`
    : `Saved listing assessment for "${outcome.role}" in ${country}: no explicit same-role sponsorship statement was verified. This is inconclusive, not evidence that sponsorship is unavailable.`)
}
