import type { ScrapedJob } from '../types'

/**
 * StepStone.de — largest German job board
 * Also covers: stepstone.at, stepstone.ch, stepstone.be, stepstone.nl, stepstone.fr
 */
export function scrapeStepstone(): ScrapedJob | null {
  // Title
  const title =
    document.querySelector<HTMLElement>('[data-testid="job-title"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.listing-detail__header-title')?.innerText.trim() ||
    document.querySelector<HTMLElement>('h1[data-at="job-title"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('h1.at-header-company-jobTitle')?.innerText.trim() ||
    null

  // Company
  const company =
    document.querySelector<HTMLElement>('[data-testid="job-company-name"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.at-listing__company-name')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-at="company-name"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.company-name')?.innerText.trim() ||
    null

  // Location
  const location =
    document.querySelector<HTMLElement>('[data-testid="job-location"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.at-listing__location')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-at="job-location"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.listing-header__location')?.innerText.trim() ||
    null

  // Salary
  const salary =
    document.querySelector<HTMLElement>('[data-testid="job-salary"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.salary-section')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="Gehalt"]')?.innerText.trim() ||
    null

  // Description
  const description =
    document.querySelector<HTMLElement>('[data-testid="job-description"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.listing-detail__description')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-at="job-description"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.job-description')?.innerText.trim() ||
    ''

  if (!title || !company) return null

  return {
    title,
    company,
    location:    location    ?? 'Unknown',
    description: description ?? '',
    salary,
    url:    window.location.href,
    source: 'stepstone',
  }
}
