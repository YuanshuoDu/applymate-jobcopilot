/**
 * Ashby public job postings API source.
 *
 * Endpoint: https://api.ashbyhq.com/posting-api/job-board/{board}
 * Docs:     https://developers.ashbyhq.com/docs/public-job-posting-api
 *
 * The public endpoint returns published postings with full HTML/plain-text
 * descriptions, direct job URLs, apply URLs, locations, and compensation.
 * This source is discovery-only; Ashby apply flow support remains an AI
 * fallback and is intentionally outside this change.
 */

import type { DiscoveredJob } from "../discover"
import { acquire } from "../pace/policies"
import { stripHtml } from "../strip-html"
import { reportJobApiJobs, trackedJobApiFetch } from "@/lib/api-usage/job-api-usage"

const BASE = "https://api.ashbyhq.com/posting-api/job-board"
const REQUEST_TIMEOUT_MS = 10_000

interface AshbyPosting {
  title?: string
  location?: string
  secondaryLocations?: Array<{ location?: string }>
  jobUrl?: string
  applyUrl?: string
  isListed?: boolean
  descriptionHtml?: string
  descriptionPlain?: string
  compensation?: { scrapeableCompensationSalarySummary?: string }
}

interface AshbyResponse {
  jobs?: AshbyPosting[]
}

function formatLocation(posting: AshbyPosting): string {
  const locations = [
    posting.location,
    ...(posting.secondaryLocations ?? []).map(location => location.location),
  ].filter((location): location is string => Boolean(location?.trim()))

  return [...new Set(locations)].join(" · ")
}

function formatDescription(posting: AshbyPosting): string {
  return posting.descriptionPlain?.trim()
    || (posting.descriptionHtml ? stripHtml(posting.descriptionHtml) : "")
}

/** Fetch published, listed Ashby postings for the given public job-board names. */
export async function fetchAshby(boardNames: string[]): Promise<DiscoveredJob[]> {
  const results: DiscoveredJob[] = []

  for (const boardName of boardNames) {
    const board = boardName.trim()
    if (!board) continue

    await acquire({ ats: "ashby" })

    try {
      const url = `${BASE}/${encodeURIComponent(board)}?includeCompensation=true`
      const response = await trackedJobApiFetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }, {
        provider: "ashby", operation: "list", credentialSource: "public",
      })

      if (!response.ok) continue

      const payload = (await response.json()) as AshbyResponse
      const postings = Array.isArray(payload.jobs) ? payload.jobs : []
      const listedPostings = postings.filter(posting => posting.isListed !== false)
      await reportJobApiJobs(response, listedPostings.length)

      for (const posting of listedPostings) {
        const title = posting.title?.trim() ?? ""
        const url = posting.applyUrl?.trim() || posting.jobUrl?.trim() || ""
        if (!title || !url) continue

        results.push({
          title,
          company: board,
          location: formatLocation(posting),
          url,
          description: formatDescription(posting),
          salary: posting.compensation?.scrapeableCompensationSalarySummary ?? null,
          logo: null,
          source: "ashby",
        })
      }
    } catch {
      // A stale board, timeout, or malformed payload must not abort the batch.
      continue
    }
  }

  return results
}
