/**
 * SmartRecruiters public API source.
 *
 * Endpoint: https://api.smartrecruiters.com/v1/companies/{slug}/postings
 * Detail:   https://api.smartrecruiters.com/v1/companies/{slug}/postings/{id}
 *
 * Returns full job descriptions via jobAd.sections on the detail endpoint.
 * Rate limit: 5 RPS (enforced via pace module).
 *
 * See: docs/scraping-autoapply-design.md §4 (ATS Coverage Matrix)
 */

import type { DiscoveredJob } from "../discover"
import { acquire } from "../pace/policies"
import { stripHtml } from "../strip-html"

const BASE = "https://api.smartrecruiters.com/v1/companies"
const PAGE_SIZE = 100
const MAX_JOBS_PER_COMPANY = 500
const REQUEST_TIMEOUT_MS = 10_000

interface SmartRecruitersPosting {
  id: string
  name: string
  ref?: string
  postingUrl?: string
  applyUrl?: string
  company?: {
    identifier?: string
    name?: string
  }
  location?: {
    city?: string
    region?: string
    country?: string
    fullLocation?: string
    remote?: boolean
  }
}

interface SmartRecruitersListResponse {
  offset?: number
  limit?: number
  totalFound?: number
  content?: SmartRecruitersPosting[]
}

interface SmartRecruitersDetail extends SmartRecruitersPosting {
  jobAd?: {
    sections?: Record<string, {
      title?: string
      text?: string
    }>
  }
}

function locationText(location?: SmartRecruitersPosting["location"]): string {
  if (!location) return ""
  if (location.fullLocation) return location.fullLocation

  const parts = [location.city, location.region, location.country].filter(Boolean)
  const base = parts.join(", ")
  return location.remote ? `Remote${base ? ` · ${base}` : ""}` : base
}

function descriptionText(detail: SmartRecruitersDetail): string {
  const sections = detail.jobAd?.sections
  if (!sections) return ""

  const preferred = [
    "companyDescription",
    "jobDescription",
    "qualifications",
    "additionalInformation",
  ]

  const ordered = [
    ...preferred,
    ...Object.keys(sections).filter((key) => !preferred.includes(key)),
  ]

  return ordered
    .map((key) => sections[key]?.text)
    .filter((text): text is string => Boolean(text))
    .map(stripHtml)
    .filter(Boolean)
    .join(" ")
}

function applyUrl(slug: string, posting: SmartRecruitersPosting, detail: SmartRecruitersDetail): string {
  return detail.applyUrl
    ?? detail.postingUrl
    ?? posting.applyUrl
    ?? posting.postingUrl
    ?? `https://jobs.smartrecruiters.com/${slug}/${posting.id}`
}

async function fetchDetail(slug: string, posting: SmartRecruitersPosting): Promise<SmartRecruitersDetail | null> {
  const url = posting.ref ?? `${BASE}/${slug}/postings/${posting.id}`

  try {
    await acquire({ ats: "smartrecruiters" })
    const r = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "ApplyMate/1.0",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!r.ok) return null
    return (await r.json()) as SmartRecruitersDetail
  } catch {
    return null
  }
}

/**
 * Fetch jobs from SmartRecruiters public API for a company slug.
 *
 * Returns an empty array when the company has no postings or the API
 * request fails. Each posting detail is isolated so one broken job does
 * not fail the whole company.
 */
export async function fetchSmartRecruiters(slug: string): Promise<DiscoveredJob[]> {
  const results: DiscoveredJob[] = []
  let offset = 0
  let totalReported = Infinity

  try {
    while (offset < totalReported && offset < MAX_JOBS_PER_COMPANY) {
      await acquire({ ats: "smartrecruiters" })
      const url = `${BASE}/${slug}/postings?offset=${offset}&limit=${PAGE_SIZE}`
      const r = await fetch(url, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "ApplyMate/1.0",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })

      if (!r.ok) break

      const json = (await r.json()) as SmartRecruitersListResponse
      const postings = json.content ?? []
      if (!postings.length) break

      if (offset === 0 && typeof json.totalFound === "number") {
        totalReported = json.totalFound
      }

      for (const posting of postings) {
        if (!posting.id || !posting.name) continue

        const detail = await fetchDetail(slug, posting)
        if (!detail) continue

        results.push({
          title:       detail.name ?? posting.name,
          company:     detail.company?.name ?? posting.company?.name ?? slug,
          location:    locationText(detail.location ?? posting.location),
          url:         applyUrl(slug, posting, detail),
          description: descriptionText(detail),
          salary:      null,
          logo:        null,
          source:      "smartrecruiters",
        })
      }

      offset += postings.length
      if (postings.length < PAGE_SIZE) break
    }
  } catch {
    return results
  }

  return results
}
