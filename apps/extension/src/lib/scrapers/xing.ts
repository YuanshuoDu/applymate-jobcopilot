import type { ScrapedJob } from '../types'

/**
 * Xing.com — German-speaking professional network (DACH region)
 * Owned by New Work SE (formerly part of Hubert Burda Media)
 */
export function scrapeXing(): ScrapedJob | null {
  // Title
  const title =
    document.querySelector<HTMLElement>('[data-xds="JobTitle"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.job-details h1')?.innerText.trim() ||
    document.querySelector<HTMLElement>('h1.job-title')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.ad-info-area h2')?.innerText.trim() ||
    null

  // Company
  const company =
    document.querySelector<HTMLElement>('[data-xds="CompanyName"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.company-name')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.job-details .employer-name')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.ad-info-area .employer')?.innerText.trim() ||
    null

  // Location
  const location =
    document.querySelector<HTMLElement>('[data-xds="Location"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.job-location')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.job-details .location')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.ad-info-area .location')?.innerText.trim() ||
    null

  // Description
  const description =
    document.querySelector<HTMLElement>('[data-xds="JobDescription"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.job-description')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.ad-description')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.jobbody')?.innerText.trim() ||
    ''

  // Xing doesn't commonly display salary in job listings

  if (!title || !company) return null

  return {
    title,
    company,
    location:    location    ?? 'Unknown',
    description: description ?? '',
    salary:      null,
    url:         window.location.href,
    source:      'xing',
  }
}
