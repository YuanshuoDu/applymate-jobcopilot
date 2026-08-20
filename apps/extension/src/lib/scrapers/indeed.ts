import type { ScrapedJob } from '../types'

function getIndeedDetailRoot(doc: Document, pageUrl: string): ParentNode | null {
  const title = doc.querySelector<HTMLElement>(
    '[data-testid="jobsearch-JobInfoHeader-title"], #vjs-jobtitle, [data-testid="jobTitle"]'
  )
  const titleRoot = title?.closest<HTMLElement>(
    '#jobsearch-ViewjobPaneWrapper, .jobsearch-ViewJobLayout--embedded, .jobsearch-JobComponent, #vjs-container, #vjs-details, #viewJobSSRRoot'
  )
  if (titleRoot) return titleRoot
  const explicitRoot = doc.querySelector<HTMLElement>(
    '#jobsearch-ViewjobPaneWrapper, #vjs-container, #vjs-details, #viewJobSSRRoot, [data-testid="viewJobSSR"]'
  )
  if (explicitRoot) return explicitRoot
  return /\/viewjob/i.test(new URL(pageUrl).pathname) ? doc : null
}

export function scrapeIndeedFromDocument(doc: Document, pageUrl: string): ScrapedJob | null {
  const root = getIndeedDetailRoot(doc, pageUrl)
  if (!root) return null
  const query = <T extends Element>(selector: string) => root.querySelector<T>(selector)

  // ── Title ──
  // [data-testid="jobsearch-JobInfoHeader-title"] has been stable since 2021.
  // h1 fallbacks handle the newer single-page job view (/viewjob?jk=...).
  // We deliberately avoid hash class names — Indeed hashes them per deploy.
  // For international TLDs, also try [data-testid="jobTitle"] (used on .de/.co.uk).
  let title =
    query<HTMLElement>('[data-testid="jobsearch-JobInfoHeader-title"]')?.innerText.trim() ||
    query<HTMLElement>('[data-testid="simpler-jobTitle"]')?.innerText.trim() ||
    query<HTMLElement>('[data-testid="job-title"]')?.innerText.trim() ||
    query<HTMLElement>('[data-testid="jobTitle"]')?.innerText.trim() ||
    query<HTMLElement>('[data-testid*="jobTitle" i]')?.innerText.trim() ||
    query<HTMLElement>('[data-testid*="job-title" i]')?.innerText.trim() ||
    query<HTMLElement>('h1[class*="jobTitle"]')?.innerText.trim() ||
    // Fallback for Indeed's embedded SPA view
    query<HTMLElement>('.jobsearch-JobInfoHeader-title span')?.innerText.trim() ||
    query<HTMLElement>('[class*="jobTitle"]')?.innerText.trim() ||
    query<HTMLElement>('h1, h2')?.innerText.trim() ||
    null

  // ── Company ──
  // Prefer the data-testid link (stable) over class-based fallbacks.
  // International TLDs sometimes use [data-testid="jobCompany"] variant.
  let company =
    query<HTMLElement>('[data-testid="inlineHeader-companyName"] a')?.innerText.trim() ||
    query<HTMLElement>('[data-testid="inlineHeader-companyName"]')?.innerText.trim() ||
    query<HTMLElement>('[data-testid="company-name"]')?.innerText.trim() ||
    query<HTMLElement>('[data-testid="jobCompany"]')?.innerText.trim() ||
    query<HTMLElement>('[data-testid*="companyName" i]')?.innerText.trim() ||
    query<HTMLElement>('[data-testid*="company-name" i]')?.innerText.trim() ||
    query<HTMLElement>('[data-company-name]')?.innerText.trim() ||
    query<HTMLElement>('[data-testid="jobsearch-CompanyInfoContainer"] a')?.innerText.trim() ||
    query<HTMLElement>('a[href*="/cmp/"]')?.innerText.trim() ||
    query<HTMLElement>('[class*="companyName"]')?.innerText.trim() ||
    query<HTMLElement>('[class*="company-name"]')?.innerText.trim() ||
    null

  // ── Location ──
  let location =
    query<HTMLElement>('[data-testid="job-location"]')?.innerText.trim() ||
    query<HTMLElement>('[data-testid="inlineHeader-companyLocation"]')?.innerText.trim() ||
    query<HTMLElement>('[data-testid="jobsearch-JobInfoHeader-companyLocation"]')?.innerText.trim() ||
    query<HTMLElement>('[data-testid="jobLocation"]')?.innerText.trim() ||
    query<HTMLElement>('[data-testid*="companyLocation" i]')?.innerText.trim() ||
    query<HTMLElement>('[data-testid*="location" i]')?.innerText.trim() ||
    query<HTMLElement>('.jobsearch-JobInfoHeader-companyLocation')?.innerText.trim() ||
    null

  // ── Salary ──
  // attribute_snippet is the most stable; #salaryInfoAndJobType is legacy but still present.
  const salaryRaw =
    query<HTMLElement>('[data-testid="attribute_snippet_testid"]')?.innerText.trim() ||
    query<HTMLElement>('#salaryInfoAndJobType')?.innerText.trim() ||
    query<HTMLElement>('[data-testid="salary"]')?.innerText.trim() ||
    query<HTMLElement>('[class*="salary"]')?.innerText.trim() ||
    null
  // Only keep if it looks like a real salary (contains currency symbol or per-year/per-month indicator)
  const salary = salaryRaw && /[$€£¥]|year|hour|annum|k\b|moon|Year|Monat|Jahr|an|hr/i.test(salaryRaw) ? salaryRaw : null

  // ── Description ──
  // #jobDescriptionText is the most stable ID Indeed uses across all TLDs.
  const description =
    query<HTMLElement>('#jobDescriptionText')?.innerText.trim() ||
    query<HTMLElement>('[data-testid="jobDescriptionText"]')?.innerText.trim() ||
    query<HTMLElement>('[data-testid*="jobDescription" i]')?.innerText.trim() ||
    query<HTMLElement>('.jobsearch-jobDescriptionText')?.innerText.trim() ||
    query<HTMLElement>('#job-description')?.innerText.trim() ||
    query<HTMLElement>('#job-content-text')?.innerText.trim() ||
    query<HTMLElement>('.jobsearch-JobComponent-description')?.innerText.trim() ||
    ''

  // ── Last resort: extract from document.title ──
  if (!title || !company) {
    const parsed = parseIndeedPageTitle(doc.title)
    if (parsed) {
      if (!title) title = parsed.title
      if (!company) company = parsed.company
      // Title-based location is more reliable than "Unknown" when DOM selectors fail
      if (!location && parsed.location) location = parsed.location
    }
  }

  if (!title || !company) return null
  title = cleanIndeedJobTitle(title)

  const parsedUrl = new URL(pageUrl)
  const jk = parsedUrl.searchParams.get('vjk') ||
    parsedUrl.searchParams.get('jk') ||
    root.querySelector<HTMLElement>('[data-jk]')?.getAttribute('data-jk')
  const canonicalUrl = jk
    ? `${parsedUrl.origin}/viewjob?jk=${encodeURIComponent(jk)}`
    : pageUrl

  return {
    title,
    company,
    location:    location    ?? 'Unknown',
    description: description ?? '',
    salary,
    url:    canonicalUrl,
    source: 'indeed',
  }
}

export function scrapeIndeed(): ScrapedJob | null {
  return scrapeIndeedFromDocument(document, window.location.href)
}

function cleanIndeedJobTitle(value: string): string {
  return value.replace(/\s*(?:\n|[-–—])\s*job post\s*$/i, '').trim()
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
