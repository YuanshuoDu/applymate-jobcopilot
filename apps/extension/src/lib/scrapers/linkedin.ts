import type { ScrapedJob } from '../types'

export function scrapeLinkedIn(): ScrapedJob | null {
  // Job title — ordered by most common LinkedIn layouts (2024-2026)
  const title =
    document.querySelector<HTMLElement>('h1.job-details-jobs-unified-top-card__job-title')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.job-details-jobs-unified-top-card__job-title h1')?.innerText.trim() ||
    document.querySelector<HTMLElement>('h1.t-24')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-test-job-title]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('h1.top-card-layout__title')?.innerText.trim() ||
    document.querySelector<HTMLElement>('h1[class*="job-title"]')?.innerText.trim() ||
    null

  // Company name
  const company =
    document.querySelector<HTMLElement>('.job-details-jobs-unified-top-card__company-name a')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.jobs-unified-top-card__company-name a')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-test-employer-name]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('a.topcard__org-name-link')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.topcard__flavor a')?.innerText.trim() ||
    null

  // Location — extract from the metadata row
  const locationEls = document.querySelectorAll<HTMLElement>(
    '.job-details-jobs-unified-top-card__primary-description-container span, ' +
    '.top-card-layout__headline span, ' +
    '.jobs-unified-top-card__bullet'
  )
  let location: string | null = null
  for (const el of locationEls) {
    const text = el.innerText.trim()
    // Skip non-location spans (like date posted, applicant count)
    if (text &&
        !text.includes('ago') &&
        !text.includes('applicant') &&
        !text.includes('Reposted') &&
        !text.includes('Easy Apply') &&
        text.length < 60) {
      location = text
      break
    }
  }

  // Salary — look for salary/compensation info
  const salaryEl =
    document.querySelector<HTMLElement>('.job-details-jobs-unified-top-card__job-insight--highlight') ||
    document.querySelector<HTMLElement>('[aria-label*="salary" i]') ||
    document.querySelector<HTMLElement>('.salary-compensation__text') ||
    document.querySelector<HTMLElement>('[class*="compensation"]') ||
    null
  const salary = salaryEl?.innerText.trim() ?? null

  // Description — try multiple layouts
  const description =
    document.querySelector<HTMLElement>('.jobs-description__content .jobs-box__html-content')?.innerText.trim() ||
    document.querySelector<HTMLElement>('#job-details')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.job-view-layout .jobs-description')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.show-more-less-html__markup')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="description"] [class*="html"]')?.innerText.trim() ||
    ''

  if (!title || !company) return null

  return {
    title,
    company,
    location:    location    ?? 'Unknown',
    description: description ?? '',
    salary,
    url:    window.location.href,
    source: 'linkedin',
  }
}
