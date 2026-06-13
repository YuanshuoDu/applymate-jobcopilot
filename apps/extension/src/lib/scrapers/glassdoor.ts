import type { ScrapedJob } from '../types'

export function scrapeGlassdoor(): ScrapedJob | null {
  const title =
    document.querySelector<HTMLElement>('[data-test="job-title"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.JobDetails_jobTitle__Rw_gn')?.innerText.trim() ||
    document.querySelector<HTMLElement>('h1[data-size="xl"]')?.innerText.trim() ||
    null

  const company =
    document.querySelector<HTMLElement>('[data-test="employer-name"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.JobDetails_companyName__t9Aq3')?.innerText.trim() ||
    null

  const location =
    document.querySelector<HTMLElement>('[data-test="location"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.JobDetails_location__MbnUM')?.innerText.trim() ||
    null

  const salary =
    document.querySelector<HTMLElement>('[data-test="detailSalary"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.JobDetails_salaryEstimate__arV5J')?.innerText.trim() ||
    null

  const description =
    document.querySelector<HTMLElement>('[class*="JobDetails_jobDescription"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('#JobDescriptionContainer')?.innerText.trim() ||
    ''

  if (!title || !company) return null

  return {
    title,
    company,
    location:    location    ?? 'Unknown',
    description: description ?? '',
    salary,
    url:    window.location.href,
    source: 'glassdoor',
  }
}
