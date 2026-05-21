/**
 * Lever public postings API source.
 *
 * Endpoint: https://api.lever.co/v0/postings/{slug}?mode=json
 * Docs:     https://lever.co/postings-api
 *
 * `?mode=json` returns all open postings in one call — no pagination.
 * Prefer `descriptionPlain` (plain text); fall back to `stripHtml(description)`.
 * Rate limit: 5 RPS (enforced via pace module).
 *
 * See: docs/scraping-autoapply-design.md §4 (ATS Coverage Matrix)
 */

import type { DiscoveredJob } from "../discover"
import { acquire } from "../pace/policies"
import { stripHtml } from "../strip-html"

const BASE = "https://api.lever.co/v0/postings"


interface LeverPosting {
  id:               string
  text:             string
  hostedUrl:        string
  descriptionPlain?: string
  description?:     string
  categories?: {
    location?:   string
    commitment?: string
    department?: string
  }
  createdAt?: number
}

/**
 * Fetch jobs from Lever public postings API for the given company slugs.
 *
 * Returns an empty array for any slug that 404s or times out —
 * a single failing slug does not fail the entire batch.
 */
export async function fetchLever(
  slugs: string[],
): Promise<DiscoveredJob[]> {
  const results: DiscoveredJob[] = []

  for (const slug of slugs) {
    await acquire({ ats: "lever" })

    try {
      const url = `${BASE}/${slug}?mode=json`
      const r = await fetch(url, {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(8_000),
      })

      if (!r.ok) continue

      const postings = (await r.json()) as LeverPosting[]
      if (!postings?.length) continue

      for (const p of postings) {
        results.push({
          title:       p.text,
          company:     slug,
          location:    p.categories?.location ?? "",
          url:         p.hostedUrl,
          description: p.descriptionPlain ?? (p.description ? stripHtml(p.description) : ""),
          salary:      null,
          logo:        null,
          source:      "lever",
        })
      }
    } catch {
      continue
    }
  }

  return results
}