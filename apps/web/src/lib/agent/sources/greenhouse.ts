/**
 * Greenhouse public boards API source.
 *
 * Endpoint: https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true
 * Docs:     https://developers.greenhouse.io/job-board.html
 *
 * Returns full job descriptions inline — no HTML scraping needed.
 * Rate limit: 5 RPS (enforced via pace module).
 *
 * See: docs/scraping-autoapply-design.md §4 (ATS Coverage Matrix)
 */

import type { DiscoveredJob } from "../discover"
import { acquire } from "../pace/policies"

const BASE = "https://boards-api.greenhouse.io/v1/boards"

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

interface GreenhouseJob {
  id:           number
  title:        string
  absolute_url: string
  location:     { name: string }
  content?:     string
  departments?: Array<{ name: string }>
  offices?:     Array<{ name: string }>
}

interface GreenhouseResponse {
  jobs: GreenhouseJob[]
}

/**
 * Fetch jobs from Greenhouse public boards for the given employer slugs.
 *
 * Returns an empty array for any slug that 404s or times out —
 * a single failing slug does not fail the entire batch.
 */
export async function fetchGreenhouse(
  slugs: string[],
): Promise<DiscoveredJob[]> {
  const results: DiscoveredJob[] = []

  for (const slug of slugs) {
    await acquire({ ats: "greenhouse" })

    try {
      const url = `${BASE}/${slug}/jobs?content=true`
      const r = await fetch(url, {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(8_000),
      })

      if (!r.ok) continue   // 404, 429, etc. — skip this slug

      const json = (await r.json()) as GreenhouseResponse
      if (!json.jobs?.length) continue

      for (const j of json.jobs) {
        results.push({
          title:       j.title,
          company:     slug,  // Greenhouse API doesn't return org name — slug is the canonical ID
          location:    j.location?.name ?? "",
          url:         j.absolute_url,
          description: j.content ? stripHtml(j.content) : "",
          salary:      null,
          logo:        null,
          source:      "greenhouse",
        })
      }
    } catch {
      // Network error / timeout — skip this slug
      continue
    }
  }

  return results
}