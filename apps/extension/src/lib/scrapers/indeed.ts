import type { ScrapedJob } from '../types'

export function scrapeIndeed(): ScrapedJob | null {
  // Title — multiple possible selectors across Indeed layouts
  const title =
    document.querySelector<HTMLElement>('[data-testid="jobsearch-JobInfoHeader-title"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.jobsearch-JobInfoHeader-title')?.innerText.trim() ||
    document.querySelector<HTMLElement>('h1.jobTitle')?.innerText.trim() ||
    null

  // Company
  const company =
    document.querySelector<HTMLElement>('[data-testid="inlineHeader-companyName"] a')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-testid="inlineHeader-companyName"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.jobsearch-InlineCompanyRating-companyHeader a')?.innerText.trim() ||
    null

  // Location
  const location =
    document.querySelector<HTMLElement>('[data-testid="job-location"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-testid="inlineHeader-companyLocation"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.jobsearch-JobInfoHeader-subtitle [data-testid]')?.innerText.trim() ||
    null

  // Salary
  const salary =
    document.querySelector<HTMLElement>('[data-testid="attribute_snippet_testid"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('#salaryInfoAndJobType')?.innerText.trim() ||
    null

  // Description
  const description =
    document.querySelector<HTMLElement>('#jobDescriptionText')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.jobsearch-jobDescriptionText')?.innerText.trim() ||
    ''

  if (!title || !company) return null

  return {
    title,
    company,
    location:    location    ?? 'Unknown',
    description: description ?? '',
    salary:      salary?.includes('$') ? salary : null,
    url:    window.location.href,
    source: 'indeed',
  }
}
