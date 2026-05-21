/**
 * CSS-based enrichment extractor — Tier 2 cascade.
 *
 * Uses cheerio to apply per-ATS CSS selectors to raw HTML.
 * Uses the existing stripHtml helper for description cleaning.
 * Returns null if no selector yields >= 200 chars — fall through to T3.
 *
 * See: docs/scraping-autoapply-design.md §5 (Enrichment Cascade)
 */

import { load, Cheerio } from "cheerio"
import type { EnrichedJob } from "../types"
import type { AtsType } from "./selectors"
import { SELECTORS } from "./selectors"

const MIN_DESC_LEN = 200

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

/**
 * Get the apply URL from a matched element.
 * Checks: direct href, child <a> href, data-href, onclick
 */
function getApplyUrl($: ReturnType<typeof load>, el: Cheerio<any>): string | undefined {
  // Direct href on the element
  const directHref = el.attr("href")
  if (directHref) return directHref

  // Child <a> element's href
  const childHref = el.find("a").first().attr("href")
  if (childHref) return childHref

  // data-href attribute
  const dataHref = el.attr("data-href")
  if (dataHref) return dataHref

  // onclick handler
  const onclick = el.attr("onclick")
  if (onclick) {
    const match = onclick.match(/(?:location|open|href)\s*[=:]\s*['"]([^'"]+)['"]/)
    if (match) return match[1]
  }

  return undefined
}

/**
 * Extract job details from raw HTML using per-ATS CSS selectors.
 *
 * @param html      Raw page HTML
 * @param ats       Which ATS type to use selectors for
 * @param sourceUrl Optional job URL (unused currently, reserved for future apply URL resolution)
 * @returns EnrichedJob if extraction succeeded, null otherwise
 */
export function extractByCssSelectors(
  html: string,
  ats: AtsType,
  _sourceUrl?: string,
): EnrichedJob | null {
  const selectors = SELECTORS[ats]
  if (!selectors) return null

  const $ = load(html)

  // Try description selectors in order
  let description = ""
  for (const sel of selectors.descriptionSelectors) {
    const text = $(sel).text().replace(/\s+/g, " ").trim()
    if (text.length >= MIN_DESC_LEN) {
      description = stripHtml(text)
      break
    }
  }

  if (!description || description.length < MIN_DESC_LEN) return null

  // Try apply URL selectors
  let applyUrl: string | undefined
  if (selectors.applyUrlSelectors) {
    for (const sel of selectors.applyUrlSelectors) {
      const el = $(sel)
      if (el.length > 0) {
        applyUrl = getApplyUrl($, el)
        if (applyUrl) break
      }
    }
  }

  return {
    description,
    applyUrl,
    method: "css",
  }
}
