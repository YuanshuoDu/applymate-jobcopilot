/**
 * JSON-LD JobPosting extractor — Tier 1 enrichment cascade.
 *
 * Scans raw HTML for <script type="application/ld+json"> blocks
 * containing @type: "JobPosting". Extracts structured job data at
 * zero token cost.
 *
 * Handles three structural variants:
 *   1. Single object:  { "@type": "JobPosting", ... }
 *   2. Array:          [{"@type":"Organization"}, {"@type":"JobPosting",...}]
 *   3. @graph nested:  { "@graph": [{"@type":"JobPosting",...}] }
 *
 * Multi-posting disambiguation: prefers the posting whose @id/url
 * matches sourceUrl, otherwise picks the one with the longest description.
 *
 * Returns null if no valid JobPosting is found with >= 200 char description.
 *
 * See: docs/scraping-autoapply-design.md §5 (Enrichment Cascade)
 */

import type { EnrichedJob } from "../types"

type JsonLdObject = Record<string, unknown>
type JobPostingLike = Record<string, unknown>

/** Strip HTML tags and decode common entities. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, '"')
    .replace(/&ldquo;/g, '"')
    .replace(/&mdash;/g, "\u2014")
    .replace(/&ndash;/g, "\u2013")
    .replace(/\s+/g, " ")
    .trim()
}

/** Regex: match <script type="application/ld+json">...</script>, capturing the inner content. */
const JSONLD_RE =
  /<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi

const MIN_DESC_LEN = 200

/**
 * Extract a JobPosting from the HTML's embedded JSON-LD.
 *
 * @param html      Raw page HTML
 * @param sourceUrl Optional URL of the job page — used to disambiguate
 *                  when a page contains multiple JobPosting entries.
 * @returns EnrichedJob if a valid posting is found, null otherwise.
 */
export function extractJsonLdJobPosting(
  html: string,
  sourceUrl?: string,
): EnrichedJob | null {
  const postings = findAllJobPostings(html)
  if (postings.length === 0) return null

  const best = pickBestPosting(postings, sourceUrl)
  if (!best) return null

  const desc = extractDescription(best)
  if (!desc || desc.length < MIN_DESC_LEN) return null

  return {
    description:    desc,
    applyUrl:       extractApplyUrl(best),
    salary:         extractSalary(best.baseSalary as Record<string, unknown> | undefined),
    employmentType: best.employmentType as string | undefined | null,
    datePosted:     best.datePosted as string | undefined | null,
    method:         "jsonld",
  }
}

// ── JSON-LD tag extraction ─────────────────────────────────────────────────

function findAllJobPostings(html: string): JobPostingLike[] {
  const results: JobPostingLike[] = []
  for (const m of html.matchAll(JSONLD_RE)) {
    const raw = m[1]
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw)
      const postings = flattenJobPostings(parsed)
      results.push(...postings)
    } catch {
      // Malformed JSON — skip this block
    }
  }
  return results
}

/** Flatten parsed JSON-LD into a list of JobPosting objects. */
function flattenJobPostings(root: unknown): JobPostingLike[] {
  const found: JobPostingLike[] = []

  function walk(node: unknown): void {
    if (!node || typeof node !== "object") return

    const obj = node as JsonLdObject

    if (isJobPosting(obj)) {
      found.push(obj)
    }

    // Recurse into arrays
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }

    // Recurse into @graph
    if (Array.isArray(obj["@graph"])) {
      walk(obj["@graph"])
    }

    // Recurse into sub-objects (some sites nest JobPosting inside mainEntity or itemListElement)
    for (const key of ["mainEntity", "itemListElement", "workPerformed"]) {
      const v = obj[key]
      if (v && (typeof v === "object" || Array.isArray(v))) {
        walk(v)
      }
    }
  }

  walk(root)
  return found
}

function isJobPosting(obj: JsonLdObject): boolean {
  const type = obj["@type"]
  if (typeof type === "string") return type === "JobPosting"
  if (Array.isArray(type)) return type.includes("JobPosting")
  return false
}

// ── Multi-posting disambiguation ───────────────────────────────────────────

function pickBestPosting(
  postings: JobPostingLike[],
  sourceUrl?: string,
): JobPostingLike | null {
  if (postings.length === 1) return postings[0]

  // Try sourceUrl match
  if (sourceUrl) {
    const match = postings.find((p) => {
      const id = p["@id"] as string | undefined
      const url = p.url as string | undefined
      return (id && sourceUrl.includes(id)) || (url && sourceUrl === url)
    })
    if (match) return match
  }

  // Pick the one with the longest description
  return postings.reduce((best, cur) => {
    const bl = (best.description as string)?.length ?? 0
    const cl = (cur.description as string)?.length ?? 0
    return cl > bl ? cur : best
  })
}

// ── Field extractors ───────────────────────────────────────────────────────

function extractDescription(posting: JobPostingLike): string | null {
  const raw = posting.description
  if (typeof raw !== "string" || !raw.trim()) return null
  return stripHtml(raw)
}

function extractApplyUrl(posting: JobPostingLike): string | undefined {
  // Prefer hiringOrganization.sameAs over posting url
  const org = posting.hiringOrganization as JsonLdObject | undefined
  const sameAs = org?.sameAs
  if (typeof sameAs === "string") return sameAs
  const url = posting.url
  if (typeof url === "string") return url
  return undefined
}

function extractSalary(
  baseSalary: Record<string, unknown> | undefined,
): string | null {
  if (!baseSalary) return null

  // Schema.org MonetaryAmount: { value: { value, minValue, maxValue, currency, unitText } }
  const value = baseSalary.value as Record<string, unknown> | undefined
  if (value && typeof value === "object") {
    const cur = (value.currency as string) ?? ""
    const sym = currencySymbol(cur)
    const uv = (value.unitText as string) ?? ""
    const per = uv ? `/${uv.toLowerCase()}` : ""
    const min = value.minValue
    const max = value.maxValue
    const singleVal = value.value
    if (typeof min === "number" && typeof max === "number") {
      return `${sym}${min.toLocaleString()}–${sym}${max.toLocaleString()}${per}`
    }
    if (typeof singleVal === "number") {
      return `${sym}${singleVal.toLocaleString()}${per}`
    }
  }

  // Flat variant: { minValue, maxValue, currency, unitText } at top level
  const cur = (baseSalary.currency as string) ?? ""
  const sym = currencySymbol(cur)
  const per = (baseSalary.unitText as string)
    ? `/${(baseSalary.unitText as string).toLowerCase()}`
    : ""
  const min = baseSalary.minValue
  const max = baseSalary.maxValue
  if (typeof min === "number" && typeof max === "number") {
    return `${sym}${min.toLocaleString()}–${sym}${max.toLocaleString()}${per}`
  }
  return null
}

function currencySymbol(code: string): string {
  const map: Record<string, string> = {
    EUR: "\u20ac", GBP: "\u00a3", USD: "$", CHF: "CHF ", SEK: "SEK ",
    NOK: "NOK ", DKK: "DKK ", PLN: "PLN ", CZK: "CZK ",
  }
  return map[code.toUpperCase()] ?? `${code} `
}
