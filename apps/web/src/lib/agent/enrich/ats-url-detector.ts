/**
 * ATS URL pattern detector — T0 enrichment layer.
 *
 * Detects Greenhouse and Lever direct job URLs and extracts the
 * employer slug + job ID so we can call the free ATS API instead
 * of scraping HTML.
 *
 * See: docs/scraping-autoapply-design.md §5 (Enrichment Cascade)
 */

export interface AtsMatch {
  ats: "greenhouse" | "lever"
  slug: string
  /** Greenhouse job ID; Lever UUID from URL path */
  jobId?: string
}

// Greenhouse: boards.greenhouse.io/{slug}/jobs/{id} or {slug}.greenhouse.io/jobs/{id}
const GH_RE =
  /https?:\/\/(?:boards\.greenhouse\.io\/([^/]+)\/jobs\/(\d+)|([^.]+)\.greenhouse\.io\/jobs\/(\d+))/i

// Lever: jobs.lever.co/{slug}/{uuid} or app.lever.co/posting/{slug}/{uuid}
const LEVER_RE =
  /https?:\/\/(?:jobs\.lever\.co\/([^/]+)\/([a-f0-9-]+)|app\.lever\.co\/posting\/([^/]+)\/([a-f0-9-]+))/i

/**
 * Detect whether a job URL points directly to a known ATS.
 *
 * @returns AtsMatch with slug extracted, or null if no pattern matches.
 */
export function detectAtsUrl(url: string): AtsMatch | null {
  if (!url) return null

  try {
    const gh = GH_RE.exec(url)
    if (gh) {
      // boards variant: gh[1]=slug, gh[2]=jobId
      // subdomain variant: gh[3]=slug, gh[4]=jobId
      const slug = gh[1] ?? gh[3] ?? ""
      const jobId = gh[2] ?? gh[4] ?? undefined
      if (!slug) return null
      return { ats: "greenhouse", slug, jobId }
    }

    const lv = LEVER_RE.exec(url)
    if (lv) {
      const slug = lv[1] ?? lv[3] ?? ""
      const jobId = lv[2] ?? lv[4] ?? undefined
      if (!slug) return null
      return { ats: "lever", slug, jobId }
    }

    return null
  } catch {
    return null
  }
}
