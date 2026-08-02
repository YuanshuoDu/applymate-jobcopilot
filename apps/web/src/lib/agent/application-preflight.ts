/**
 * Deterministic checks that run before an Agent spends credits on an
 * application or permits a browser worker to touch an external form.
 *
 * This is deliberately program-owned: an LLM may explain an issue, but it
 * cannot waive a destination or job-identity safety rule.
 */
export type ApplicationPreflightInput = {
  company: string | null | undefined
  description: string | null | undefined
  source: string | null | undefined
  url: string | null | undefined
}

export type ApplicationPreflightIssue = {
  code: "company_mismatch" | "missing_description" | "unsupported_destination"
  message: string
}

export type ApplicationPreflight = {
  canPrepare: boolean
  canAutomate: boolean
  issues: ApplicationPreflightIssue[]
}

const SUPPORTED_ATS = [
  /(?:^|\.)myworkdayjobs\.com$/i,
  /(?:^|\.)greenhouse\.io$/i,
  /(?:^|\.)lever\.co$/i,
  /(?:^|\.)smartrecruiters\.com$/i,
  /(?:^|\.)jobs\.personio\.com$/i,
]

const GENERIC_COMPANY_CLAIMS = new Set(["our", "the", "us", "team", "future", "company"])

function normalizeCompany(value: string) {
  return value.toLowerCase()
    .replace(/\b(inc|ltd|llc|gmbh|limited|plc|ag|bv)\b/g, "")
    .replace(/[^a-z0-9]+/g, "")
}

function directAtsUrl(rawUrl: string | null | undefined): boolean {
  if (!rawUrl) return false
  try {
    const url = new URL(rawUrl)
    return (url.protocol === "https:" || url.protocol === "http:")
      && SUPPORTED_ATS.some(pattern => pattern.test(url.hostname))
  } catch {
    return false
  }
}

/** Extract only explicit company claims from the opening of a job description. */
function openingCompanyClaims(description: string): string[] {
  const opening = description.slice(0, 1_200)
  const claims = [
    ...opening.matchAll(/\b[Jj]oin\b[^.\n]{0,100}?\b[Ww]ith\s+([A-Z][\w&'.-]*(?:\s+[A-Z][\w&'.-]*){0,3})/g),
    ...opening.matchAll(/\b(?:[Aa]t|[Ff]rom)\s+([A-Z][\w&'.-]*(?:\s+[A-Z][\w&'.-]*){0,3})(?=\s+(?:we|is|are|has|will|you)\b|[,.])/g),
  ]
  return claims
    .map(match => match[1]?.trim() ?? "")
    .filter(claim => claim && !GENERIC_COMPANY_CLAIMS.has(normalizeCompany(claim)))
}

function hasCompanyConflict(input: ApplicationPreflightInput): boolean {
  if (!input.company || !input.description) return false
  const expected = normalizeCompany(input.company)
  if (!expected) return false
  const claims = openingCompanyClaims(input.description)
  return claims.some(claim => {
    const actual = normalizeCompany(claim)
    if (!actual || actual.includes(expected) || expected.includes(actual)) return false
    // A single capitalized phrase can be a product or technology rather than
    // an employer. Require the claimed name to be repeated in the opening
    // before blocking an application; a false negative is safer than blocking
    // a legitimate candidate from a real employer site.
    return input.description!.slice(0, 1_200).toLowerCase().split(claim.toLowerCase()).length >= 3
  })
}

export function assessApplicationPreflight(input: ApplicationPreflightInput): ApplicationPreflight {
  const issues: ApplicationPreflightIssue[] = []
  if (!input.description?.trim()) {
    issues.push({
      code: "missing_description",
      message: "A complete job description is required before materials can be generated.",
    })
  }
  if (hasCompanyConflict(input)) {
    issues.push({
      code: "company_mismatch",
      message: "The saved company does not match an explicit company named in the job description.",
    })
  }
  if (!directAtsUrl(input.url)) {
    issues.push({
      code: "unsupported_destination",
      message: "Autonomous applications require a direct Greenhouse, Lever, Workday, SmartRecruiters, or Personio link.",
    })
  }
  const canPrepare = !issues.some(issue => issue.code !== "unsupported_destination")
  return { canPrepare, canAutomate: canPrepare && !issues.some(issue => issue.code === "unsupported_destination"), issues }
}

export function isSupportedAutomatedApplyUrl(url: string | null | undefined) {
  return directAtsUrl(url)
}
