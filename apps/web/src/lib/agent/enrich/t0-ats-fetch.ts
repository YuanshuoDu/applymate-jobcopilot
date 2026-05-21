/**
 * T0 ATS API fetcher — calls Greenhouse/Lever APIs directly
 * when a job URL matches a known ATS pattern.
 *
 * Falls back to null on any error so the enrichment cascade
 * continues to T1 (JSON-LD) / T2 (CSS) / T3 (LLM).
 *
 * See: docs/scraping-autoapply-design.md §5 (Enrichment Cascade)
 */

import type { EnrichedJob } from "../types"
import type { AtsMatch } from "./ats-url-detector"
import { acquire } from "../pace/policies"
import { db } from "@/lib/db"

/** Strip HTML tags and decode common entities (local copy). */
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

/**
 * Fetch job details from the ATS API based on a URL pattern match.
 *
 * Respects rate limits (pace.acquire) and returns null on failure
 * so downstream enrichment tiers can take over.
 *
 * On success, upserts the employer slug into the ats_employers table.
 */
export async function fetchViaAtsApi(
  match: AtsMatch,
): Promise<EnrichedJob | null> {
  try {
    const result = match.ats === "greenhouse"
      ? await fetchGreenhouseJob(match)
      : await fetchLeverJob(match)

    if (!result) return null

    // Upsert employer into dynamic registry
    await db.atsEmployer.upsert({
      where: { atsType_slug: { atsType: match.ats, slug: match.slug } },
      update: { lastSeen: new Date(), jobCount: { increment: 1 } },
      create: { atsType: match.ats, slug: match.slug },
    }).catch(() => { /* non-blocking */ })

    return result
  } catch {
    return null
  }
}

// ── Greenhouse individual-job fetch ─────────────────────────────────────────

async function fetchGreenhouseJob(
  match: AtsMatch,
): Promise<EnrichedJob | null> {
  await acquire({ ats: "greenhouse" })

  const url = `https://boards-api.greenhouse.io/v1/boards/${match.slug}/jobs/${match.jobId}?content=true`
  const r = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  })

  if (!r.ok) return null

  const json = (await r.json()) as {
    title?: string
    content?: string
    absolute_url?: string
  }
  const description = json.content ? stripHtml(json.content) : ""
  if (!description) return null

  return {
    description,
    applyUrl: json.absolute_url,
    method: "t0-ats",
  }
}

// ── Lever individual-job fetch ──────────────────────────────────────────────

interface LeverPosting {
  id: string
  text: string
  hostedUrl: string
  descriptionPlain?: string
  description?: string
}

async function fetchLeverJob(
  match: AtsMatch,
): Promise<EnrichedJob | null> {
  await acquire({ ats: "lever" })

  const url = `https://api.lever.co/v0/postings/${match.slug}?mode=json`
  const r = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  })

  if (!r.ok) return null

  const postings = (await r.json()) as LeverPosting[]
  if (!postings?.length) return null

  // Find the posting whose hostedUrl matches our UUID
  const posting = postings.find((p) =>
    match.jobId ? p.hostedUrl.includes(match.jobId) : false,
  )
  if (!posting) return null

  const description =
    posting.descriptionPlain ??
    (posting.description ? stripHtml(posting.description) : "")
  if (!description) return null

  return {
    description,
    applyUrl: posting.hostedUrl,
    method: "t0-ats",
  }
}
