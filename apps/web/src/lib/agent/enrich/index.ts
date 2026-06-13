/**
 * Enrichment cascade orchestrator — T0 → T1 → T2 → T3.
 *
 * Takes raw job page HTML + source URL and runs enrichment tiers
 * in order, returning the first successful result. Each tier is
 * progressively more expensive (API cost / token cost).
 *
 * T0: ATS API           free, zero-token
 * T1: JSON-LD parsing   zero-token
 * T2: CSS selectors     zero-token (cheerio)
 * T3: null              caller falls back to LLM
 *
 * See: docs/scraping-autoapply-design.md §5 (Enrichment Cascade)
 */

import type { EnrichedJob } from "../types"
import { detectAtsUrl } from "./ats-url-detector"
import { fetchViaAtsApi } from "./t0-ats-fetch"
import { extractJsonLdJobPosting } from "./jsonld"
import { detectAtsByUrl } from "./detect"
import { extractByCssSelectors } from "./css"

export interface EnrichInput {
  html: string
  url: string
}

/**
 * Run the enrichment cascade on a job page.
 *
 * Stops at the first tier that returns a result. Returns null
 * only when every tier misses — caller should then invoke an LLM.
 *
 * Logs per-call structured data to console: tier, hit/miss, duration.
 */
export async function enrichJob(
  input: EnrichInput,
): Promise<EnrichedJob | null> {
  const { html, url } = input

  // ── T0: ATS API ──────────────────────────────────────────────────────
  const t0Start = performance.now()
  const atsMatch = detectAtsUrl(url)
  if (atsMatch) {
    console.log("[enrich]", `t0-detected ats=${atsMatch.ats} slug=${atsMatch.slug}`)
    const t0Result = await fetchViaAtsApi(atsMatch)
    if (t0Result) {
      const ms = Math.round(performance.now() - t0Start)
      console.log("[enrich]", `t0-hit method=${t0Result.method} descLen=${t0Result.description.length} duration=${ms}ms`)
      return t0Result
    }
    console.log("[enrich]", "t0-miss ats-api-returned-null")
  } else {
    console.log("[enrich]", "t0-miss no-ats-url-pattern")
  }

  // ── T1: JSON-LD ──────────────────────────────────────────────────────
  const t1Start = performance.now()
  const t1Result = extractJsonLdJobPosting(html, url)
  if (t1Result) {
    const ms = Math.round(performance.now() - t1Start)
    console.log("[enrich]", `t1-hit method=${t1Result.method} descLen=${t1Result.description.length} duration=${ms}ms`)
    return t1Result
  }
  console.log("[enrich]", "t1-miss no-jsonld-jobposting")

  // ── T2: CSS selectors ────────────────────────────────────────────────
  const t2Start = performance.now()
  const ats = detectAtsByUrl(url)
  if (ats) {
    const t2Result = extractByCssSelectors(html, ats)
    if (t2Result) {
      const ms = Math.round(performance.now() - t2Start)
      console.log("[enrich]", `t2-hit ats=${ats} method=${t2Result.method} descLen=${t2Result.description.length} duration=${ms}ms`)
      return t2Result
    }
    console.log("[enrich]", `t2-miss ats=${ats} no-selectors-matched`)
  } else {
    console.log("[enrich]", "t2-miss unknown-ats-cannot-apply-selectors")
  }

  // ── T3: LLM fallback ─────────────────────────────────────────────────
  console.log("[enrich]", "t3-fallback returning-null-caller-should-use-llm")
  return null
}
