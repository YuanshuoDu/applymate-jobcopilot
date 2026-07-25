import type { ScrapedJob } from '../types'

export function scrapeIndeed(): ScrapedJob | null {
  // ── Title ──
  // [data-testid="jobsearch-JobInfoHeader-title"] has been stable since 2021.
  // h1 fallbacks handle the newer single-page job view (/viewjob?jk=...).
  // We deliberately avoid hash class names — Indeed hashes them per deploy.
  // For international TLDs, also try [data-testid="jobTitle"] (used on .de/.co.uk).
  let title =
    document.querySelector<HTMLElement>('[data-testid="jobsearch-JobInfoHeader-title"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-testid="simpler-jobTitle"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-testid="job-title"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-testid="jobTitle"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-testid*="jobTitle" i]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-testid*="job-title" i]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('h1[class*="jobTitle"]')?.innerText.trim() ||
    // Fallback for Indeed's embedded SPA view
    document.querySelector<HTMLElement>('.jobsearch-JobInfoHeader-title span')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="jobTitle"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('h1')?.innerText.trim() ||
    null

  // ── Company ──
  // Prefer the data-testid link (stable) over class-based fallbacks.
  // International TLDs sometimes use [data-testid="jobCompany"] variant.
  let company =
    document.querySelector<HTMLElement>('[data-testid="inlineHeader-companyName"] a')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-testid="inlineHeader-companyName"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-testid="company-name"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-testid="jobCompany"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-testid*="companyName" i]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-testid*="company-name" i]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-company-name]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-testid="jobsearch-CompanyInfoContainer"] a')?.innerText.trim() ||
    document.querySelector<HTMLElement>('a[href*="/cmp/"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="companyName"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="company-name"]')?.innerText.trim() ||
    null

  // ── Location ──
  const location =
    document.querySelector<HTMLElement>('[data-testid="job-location"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-testid="inlineHeader-companyLocation"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-testid="jobsearch-JobInfoHeader-companyLocation"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-testid="jobLocation"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-testid*="companyLocation" i]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-testid*="location" i]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.jobsearch-JobInfoHeader-companyLocation')?.innerText.trim() ||
    null

  // ── Salary ──
  // attribute_snippet is the most stable; #salaryInfoAndJobType is legacy but still present.
  const salaryRaw =
    document.querySelector<HTMLElement>('[data-testid="attribute_snippet_testid"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('#salaryInfoAndJobType')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-testid="salary"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="salary"]')?.innerText.trim() ||
    null
  // Only keep if it looks like a real salary (contains currency symbol or per-year/per-month indicator)
  const salary = salaryRaw && /[$€£¥]|year|hour|annum|k\b|月|年|Monat|Jahr|an|hr/i.test(salaryRaw) ? salaryRaw : null

  // ── Description ──
  // #jobDescriptionText is the most stable ID Indeed uses across all TLDs.
  const description =
    document.querySelector<HTMLElement>('#jobDescriptionText')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-testid="jobDescriptionText"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-testid*="jobDescription" i]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.jobsearch-jobDescriptionText')?.innerText.trim() ||
    document.querySelector<HTMLElement>('#job-description')?.innerText.trim() ||
    document.querySelector<HTMLElement>('#job-content-text')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.jobsearch-JobComponent-description')?.innerText.trim() ||
    ''

  // ── Last resort: extract from document.title ──
  if (!title || !company) {
    const parsed = parseIndeedPageTitle(document.title)
    if (parsed) {
      if (!title) title = parsed.title
      if (!company) company = parsed.company
      // Title-based location is more reliable than "Unknown" when DOM selectors fail
      if (!location && parsed.location) location = parsed.location
    }
  }

  if (!title || !company) return null

  return {
    title,
    company,
    location:    location    ?? 'Unknown',
    description: description ?? '',
    salary,
    url:    window.location.href,
    source: 'indeed',
  }
}

/** Extract job title, company, and location from Indeed's <title> text. */
function parseIndeedPageTitle(t: string): { title: string; company: string; location?: string } | null {
  if (!t || t.length < 3) return null

  // Strip Indeed.com suffix
  const clean = t
    .replace(/\s*[-–—|]\s*Indeed(?:\.com)?\s*$/i, '')
    .replace(/\s*\|\s*Indeed\s*$/i, '')
    .trim()
  if (!clean) return null

  // Indeed format: "Job Title - Company - Location"
  // or: "Job Title - Company" or "Job Title at Company"
  const parts = clean.split(/\s+[-–—]\s+/)
  if (parts.length >= 3) {
    // "Job Title - Company - Location"
    return {
      title: parts[0].trim(),
      company: parts[1].trim(),
      location: parts.slice(2).join(', ').trim(),
    }
  }
  if (parts.length === 2) {
    return {
      title: parts[0].trim(),
      company: parts[1].trim(),
    }
  }

  // "Job Title at Company"
  for (const sep of [' at ', ' - ', ' – ', ' — ', ' | ']) {
    const idx = clean.indexOf(sep)
    if (idx > 0) {
      const title = clean.slice(0, idx).trim()
      const rest = clean.slice(idx + sep.length).trim()
      // Rest might be "Company - Location" or just "Company"
      const restParts = rest.split(/\s+[-–—]\s+/)
      if (restParts.length >= 2) {
        return {
          title,
          company: restParts[0].trim(),
          location: restParts.slice(1).join(', ').trim(),
        }
      }
      return { title, company: rest }
    }
  }

  return null
}
