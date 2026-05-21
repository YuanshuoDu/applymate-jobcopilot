/**
 * CSS selectors for known ATS career pages — Tier 2 enrichment.
 *
 * Each ATS has a set of CSS selectors tried in order until one
 * yields >= 200 chars of description text. Selectors are verified
 * against live pages at PR time.
 *
 * Selectors will degrade over time as ATS DOMs change. The Tier 3
 * LLM fallback catches misses — no selector resilience engineering needed.
 *
 * See: docs/scraping-autoapply-design.md §5 (Enrichment Cascade)
 */

export type AtsType = "workday" | "greenhouse" | "lever" | "smartrecruiters"

export interface AtsSelectors {
  /** CSS selectors for the job description container, tried in order */
  descriptionSelectors: string[]
  /** CSS selectors for the apply button/link, looked up for href */
  applyUrlSelectors?: string[]
  /** CSS selectors for salary info */
  salarySelectors?: string[]
}

export const SELECTORS: Record<AtsType, AtsSelectors> = {
  // Verified: booking.wd3.myworkdayjobs.com/Careers/job/...
  workday: {
    descriptionSelectors: [
      '[data-automation-id="jobPostingDescription"]',
      '[data-automation-id="job-posting-description"]',
    ],
    applyUrlSelectors: [
      '[data-automation-id="adventureButton"]',
      '[data-automation-id="applyButton"]',
      '[data-automation-id="apply"]',
    ],
  },

  // Verified: boards.greenhouse.io/shopify/jobs/...
  greenhouse: {
    descriptionSelectors: [
      ".opening section",
      "#content .section-wrapper",
      ".job__description",
    ],
    applyUrlSelectors: [
      "a.application-button",
      'a[href*="apply"]',
    ],
  },

  // Verified: jobs.lever.co/spotify/...
  lever: {
    descriptionSelectors: [
      ".section.posting-page .posting-description",
      ".content-wrapper .section-wrapper",
      ".posting-description",
    ],
    applyUrlSelectors: [
      'a.postings-btn[href*="apply"]',
      'a[href*="/apply"]',
    ],
  },

  // Verified: careers.smartrecruiters.com/...
  smartrecruiters: {
    descriptionSelectors: [
      ".job-sections",
      "#st-jobDescription",
      ".job-description",
    ],
    applyUrlSelectors: [
      'a[href*="apply"]',
    ],
  },
}
