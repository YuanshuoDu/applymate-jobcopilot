/**
 * ATS detection from job page URL — basic pattern matching.
 *
 * Used by T2 CSS extraction to decide which selector set to use.
 * Simple substring checks — no regex needed for most patterns.
 *
 * See: selectors.ts for the AtsType definitions.
 */

import type { AtsType } from "./selectors"

/**
 * Detect which ATS a job URL belongs to, based on known host patterns.
 *
 * @returns AtsType if the URL matches a known ATS host, null otherwise.
 */
export function detectAtsByUrl(url: string): AtsType | null {
  if (!url) return null
  const lower = url.toLowerCase()

  // Workday: *.wd{N}.myworkdayjobs.com
  if (lower.includes(".myworkdayjobs.com")) return "workday"

  // Greenhouse: boards.greenhouse.io or *.greenhouse.io
  if (lower.includes(".greenhouse.io")) return "greenhouse"

  // Lever: jobs.lever.co or app.lever.co
  if (lower.includes(".lever.co")) return "lever"

  // SmartRecruiters: careers.smartrecruiters.com or *.smartrecruiters.com
  if (lower.includes(".smartrecruiters.com")) return "smartrecruiters"

  return null
}
