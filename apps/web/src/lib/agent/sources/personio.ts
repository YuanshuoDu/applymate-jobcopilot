/**
 * Personio public XML feed source.
 *
 * Endpoint: https://{slug}.jobs.personio.com/xml
 *
 * Personio is the dominant HR/ATS platform for German SMBs (10-500 employees).
 * Each employer publishes a public XML feed listing all open positions.
 * No auth required. We enforce our own rate limit via the pace module.
 *
 * The XML feed structure (confirmed against real Personio feeds, May 2026):
 *   <workzag-jobs>
 *     <position>
 *       <id>1834171</id>
 *       <name>Staff Software Engineer, Data Platform</name>
 *       <subcompany>Personio SE & Co. KG</subcompany>
 *       <office>Munich</office>
 *       <department>Product and Tech</department>
 *       <recruitingCategory>Engineering</recruitingCategory>
 *       <jobDescriptions>CDATA or plain text</jobDescriptions>
 *       <employmentType>permanent</employmentType>
 *       <seniority>experienced</seniority>
 *       <schedule>full-time</schedule>
 *       <yearsOfExperience>7-10</yearsOfExperience>
 *       <occupation>software_and_web_development</occupation>
 *       <occupationCategory>it_software</occupationCategory>
 *       <createdAt>2024-11-13T14:10:41+00:00</createdAt>
 *     </position>
 *   </workzag-jobs>
 *
 * Fallback: also recognizes legacy German-tag format (<stellenanzeigen>,
 * <stellenanzeige>, <title>, <unternehmen>, <stadt>, <land>,
 * <stellenbeschreibung>, <url>) for feeds that still use it.
 *
 * Full descriptions returned inline → skips enrichment cascade.
 *
 * See: docs/scraping-autoapply-design.md §4 (ATS Coverage Matrix)
 */

import type { DiscoveredJob } from "../discover"
import { acquire } from "../pace/policies"

const REQUEST_TIMEOUT_MS = 10_000

/**
 * Extract text from a tag, handling CDATA and plain text.
 * Matches the first occurrence of the tag within the XML snippet.
 */
function extractTag(xml: string, tag: string): string {
  // CDATA variant: <tag><![CDATA[...]]></tag>
  const cdataRe = new RegExp(
    `<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`,
    "i"
  )
  const cdataMatch = cdataRe.exec(xml)
  if (cdataMatch?.[1]) return cdataMatch[1].trim()

  // Plain text variant: <tag>text</tag>
  const plainRe = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i")
  const plainMatch = plainRe.exec(xml)
  if (plainMatch?.[1]) {
    const text = plainMatch[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim()
    if (text) return text
  }

  // Self-closing or empty: <tag/>
  return ""
}

/** Strip common HTML entities and collapse whitespace. */
function clean(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Fetch jobs from the Personio public XML feed for a company slug.
 *
 * Returns an empty array when the feed is unreachable, returns non-200,
 * or contains zero position entries.
 */
export async function fetchPersonio(slug: string): Promise<DiscoveredJob[]> {
  const results: DiscoveredJob[] = []
  const url = `https://${slug}.jobs.personio.com/xml`

  try {
    await acquire({ ats: "personio" })
    const r = await fetch(url, {
      headers: {
        "User-Agent": "ApplyMate/1.0",
        "Accept": "application/xml, text/xml, */*",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!r.ok) return []
    const xml = await r.text()

    // Detect feed format: modern (<workzag-jobs>/<position>) or legacy German
    const isModern = xml.includes("<workzag-jobs")
    const wrapperTag = isModern ? "position" : "stellenanzeige"
    if (!xml.includes(`<${wrapperTag}`)) return []

    // Extract each job block
    const blockRe = new RegExp(`<${wrapperTag}[^>]*>([\\s\\S]*?)<\\/${wrapperTag}>`, "gi")
    const blocks = [...xml.matchAll(blockRe)]

    for (const match of blocks) {
      const block = match[1]

      if (isModern) {
        // ── Modern Personio XML format ────────────────────────────────────
        const name = extractTag(block, "name")
        const company = extractTag(block, "subcompany")
        const office = extractTag(block, "office")
        const jobId = extractTag(block, "id")
        const description =
          extractTag(block, "jobDescriptions") ||
          extractTag(block, "jobDescription") ||
          extractTag(block, "description")
        const department = extractTag(block, "department")
        const employmentType = extractTag(block, "employmentType")

        if (!name || !jobId) continue

        const jobUrl = `https://${slug}.jobs.personio.com/job/${jobId}`
        const locationParts = [office]
        if (department) locationParts.push(department)
        const location = locationParts.filter(Boolean).join(" · ") || "Germany"

        results.push({
          title:       clean(name),
          company:     clean(company) || slug,
          location:    location,
          url:         jobUrl,
          description: clean(description),
          salary:      employmentType ? clean(employmentType) : null,
          logo:        null,
          source:      "personio",
        })
      } else {
        // ── Legacy German XML format (fallback) ──────────────────────────
        const title = extractTag(block, "title") || extractTag(block, "stellenname")
        const company = extractTag(block, "unternehmen") || extractTag(block, "company")
        const city = extractTag(block, "stadt") || extractTag(block, "city")
        const country = extractTag(block, "land") || extractTag(block, "country")
        const description =
          extractTag(block, "stellenbeschreibung") ||
          extractTag(block, "description") ||
          extractTag(block, "jobDescriptions")
        const legacyId = extractTag(block, "id")
        const jobUrl =
          extractTag(block, "url") ||
          extractTag(block, "apply_url") ||
          (legacyId ? `https://${slug}.jobs.personio.com/job/${legacyId}` : "")

        if (!title || !jobUrl) continue
        const location = [city, country].filter(Boolean).join(", ") || "Germany"

        results.push({
          title:       clean(title),
          company:     clean(company) || slug,
          location:    location,
          url:         jobUrl,
          description: clean(description),
          salary:      null,
          logo:        null,
          source:      "personio",
        })
      }
    }
  } catch {
    // Network error / timeout / parse failure → empty
    return results
  }

  return results
}