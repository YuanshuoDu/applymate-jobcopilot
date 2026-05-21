/**
 * Workday CXS JSON API discovery source.
 *
 * Hits the internal Career Experience Suite (CXS) API used by every
 * Workday career site — HTTP-only, no browser needed. Returns full
 * job descriptions and apply URLs for zero enrichment LLM cost.
 *
 * Endpoint patterns:
 *   Search:  POST {baseUrl}/wday/cxs/{tenant}/{siteId}/jobs
 *   Detail:  GET  {baseUrl}/wday/cxs/{tenant}/{siteId}{externalPath}
 *
 * Rate limit: 1 RPS per tenant (enforced via pace module).
 *
 * See: docs/scraping-autoapply-design.md §4 (ATS Coverage Matrix)
 *      Issue #30 (Phase 2.1+2.2)
 */

import type { DiscoveredJob } from "../discover"
import { acquire } from "../pace/policies"
import type { WorkdayEmployer } from "../registries"

const MAX_JOBS_PER_EMPLOYER = 500
const PAGE_SIZE = 20
const REQUEST_TIMEOUT_MS = 15_000
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

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

// ── CXS API response types ──────────────────────────────────────────────

interface CxsSearchResult {
  total: number
  jobPostings: CxsPosting[]
}

interface CxsPosting {
  title: string
  locationsText?: string
  postedOn?: string
  externalPath: string
}

interface CxsDetail {
  jobPostingInfo: {
    jobDescription?: string
    externalUrl?: string
    timeType?: string
  }
}

// ── Fetch helpers ────────────────────────────────────────────────────────

async function fetchSearch(
  employer: WorkdayEmployer,
  offset: number,
): Promise<CxsSearchResult | null> {
  const url = `${employer.baseUrl}/wday/cxs/${employer.tenant}/${employer.siteId}/jobs`
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        appliedFacets: {},
        limit: PAGE_SIZE,
        offset,
        searchText: "",
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!r.ok) return null
    const json = (await r.json()) as CxsSearchResult
    if (!json.jobPostings?.length) return null
    return json
  } catch {
    return null
  }
}

async function fetchDetail(
  employer: WorkdayEmployer,
  externalPath: string,
): Promise<CxsDetail | null> {
  const url = `${employer.baseUrl}/wday/cxs/${employer.tenant}/${employer.siteId}${externalPath}`
  try {
    const r = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!r.ok) return null
    return (await r.json()) as CxsDetail
  } catch {
    return null
  }
}

// ── Main export ──────────────────────────────────────────────────────────

/**
 * Fetch all open jobs from the given Workday employers.
 *
 * Paginates through search results and fetches detail for each posting.
 * A single employer failing (timeout / 404 / auth error) does not
 * abort the batch — it is skipped and the rest continue.
 */
export async function fetchWorkday(
  employers: WorkdayEmployer[],
): Promise<DiscoveredJob[]> {
  const results: DiscoveredJob[] = []

  for (const employer of employers) {
    try {
      let offset = 0
      let totalReported = Infinity

      while (offset < totalReported && offset < MAX_JOBS_PER_EMPLOYER) {
        // Get one page's search results
        await acquire({ ats: "workday" })
        const search = await fetchSearch(employer, offset)
        if (!search) break  // employer unreachable — skip entirely

        // Update total from first page
        if (offset === 0 && search.total) {
          totalReported = search.total
        }

        // Fetch detail for each posting on this page
        for (const posting of search.jobPostings) {
          if (!posting.externalPath) continue

          await acquire({ ats: "workday" })

          const detail = await fetchDetail(employer, posting.externalPath)

          const description = detail?.jobPostingInfo?.jobDescription
            ? stripHtml(detail.jobPostingInfo.jobDescription)
            : ""

          const applyUrl = detail?.jobPostingInfo?.externalUrl ?? ""

          results.push({
            title:       posting.title,
            company:     employer.name,
            location:    posting.locationsText ?? "",
            url:         applyUrl,
            description,
            salary:      null,
            logo:        null,
            source:      "workday",
          })
        }

        offset += PAGE_SIZE

        // If no more postings in this page, we're done
        if (search.jobPostings.length < PAGE_SIZE) break
      }
    } catch {
      // Employer-level failure — skip and continue
      continue
    }
  }

  return results
}
