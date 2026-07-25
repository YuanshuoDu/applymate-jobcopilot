import type { ScrapedJob } from '../types'

export function scrapeLinkedIn(): ScrapedJob | null {
  // ── Title ──
  // Stable attribute-based selectors first (LinkedIn internal attributes don't change with UI refreshes),
  // then class-based fallbacks for legacy layouts.
  let title =
    // 2026+: internal data attributes
    document.querySelector<HTMLElement>('[data-job-name]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[aria-label*="job title" i]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[aria-label*="职位名称" i]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-test-job-title]')?.innerText.trim() ||
    // 2025-2026 LinkedIn top card
    document.querySelector<HTMLElement>('h1[class*="title"]')?.innerText.trim() ||
    // 2024 LinkedIn unified top card
    document.querySelector<HTMLElement>('h1.job-details-jobs-unified-top-card__job-title')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.job-details-jobs-unified-top-card__job-title h1')?.innerText.trim() ||
    // 2023 LinkedIn
    document.querySelector<HTMLElement>('h1.t-24')?.innerText.trim() ||
    document.querySelector<HTMLElement>('h1.top-card-layout__title')?.innerText.trim() ||
    document.querySelector<HTMLElement>('h1[class*="job-title"]')?.innerText.trim() ||
    // Generic fallback: first h1 in main content
    document.querySelector<HTMLElement>('main h1')?.innerText.trim() ||
    null

  // ── Company ──
  // Order: targeted selectors first, then DOM-text selectors, then alt-text
  // fallbacks. a[href*="/company/"] is used first because it's the most
  // reliable — img alt selectors can match unrelated elements on panel pages.
  let company =
    document.querySelector<HTMLElement>('[data-test-employer-name]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-company-name]')?.innerText.trim() ||
    // Company name link in top card — most reliable DOM-text selector
    document.querySelector<HTMLElement>('.job-details-jobs-unified-top-card__company-name a')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.jobs-unified-top-card__company-name a')?.innerText.trim() ||
    document.querySelector<HTMLElement>('a.topcard__org-name-link')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.topcard__flavor a')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="company-name"] a')?.innerText.trim() ||
    document.querySelector<HTMLElement>('a[href*="/company/"]')?.innerText.trim() ||
    // Fallback: any company link near the h1
    document.querySelector<HTMLElement>('h1 ~ div a[href*="/company/"]')?.innerText.trim() ||
    // Company logo alt attribute — only within job-top-card, not page-wide
    (document.querySelector<HTMLImageElement>('.jobs-unified-top-card img[alt*="logo" i]')?.alt?.trim().replace(/\s*logo\s*/i, '').trim()) ||
    (document.querySelector<HTMLImageElement>('.job-details-jobs-unified-top-card img[alt*="logo" i]')?.alt?.trim().replace(/\s*logo\s*/i, '').trim()) ||
    null

  // ── Location ──
  // First try stable data-testid / data attributes
  let location: string | null =
    document.querySelector<HTMLElement>('[data-test-location]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-job-location]')?.innerText.trim() ||
    null

  if (!location) {
    // Fallback: iterate through likely location elements, filtering out non-location text
    const locationEls = document.querySelectorAll<HTMLElement>(
      '.job-details-jobs-unified-top-card__primary-description-container span, ' +
      '.top-card-layout__headline span, ' +
      '.jobs-unified-top-card__bullet, ' +
      '.jobs-unified-top-card__primary-description span, ' +
      'h1 ~ div span, ' +
      '[class*="location"] span'
    )
    // Terms that indicate the text is NOT a location
    const nonLocationTerms = ['ago', 'applicant', 'Reposted', 'Easy Apply', 'view', 'connections', 'applied']
    // Valid location/city terms that should NOT be filtered
    const validLocationTerms = ['Remote', 'Hybrid', 'On-site', 'On site', 'Lisbon', 'Berlin', 'Munich',
      'London', 'Paris', 'Amsterdam', 'Madrid', 'Dublin', 'Stockholm', 'Copenhagen',
      'remote', 'hybrid', 'on-site', 'onsite']

    for (const el of locationEls) {
      const text = el.innerText.trim()
      if (!text) continue
      if (text.length >= 80) continue
      // Check if it looks like a location (contains a valid city term or doesn't contain non-location terms)
      const hasNonLocation = nonLocationTerms.some(t => text.toLowerCase().includes(t.toLowerCase()))
      const hasValidLocation = validLocationTerms.some(t => text.toLowerCase().includes(t.toLowerCase()))
      if (hasValidLocation || !hasNonLocation) {
        location = text
        break
      }
    }
  }

  // ── Salary ──
  const salaryEl =
    document.querySelector<HTMLElement>('.job-details-jobs-unified-top-card__job-insight--highlight') ||
    document.querySelector<HTMLElement>('[aria-label*="salary" i]') ||
    document.querySelector<HTMLElement>('.salary-compensation__text') ||
    document.querySelector<HTMLElement>('[class*="compensation"]') ||
    document.querySelector<HTMLElement>('[class*="salary"]') ||
    null
  const salary = salaryEl?.innerText.trim() ?? null

  // ── Description ──
  // Multiple fallbacks for LinkedIn's ever-changing DOM structure.
  // The jobs-description__content and show-more-less-html patterns have been stable
  // for the longest period. #job-details was the 2023 approach.
  let description =
    document.querySelector<HTMLElement>('.jobs-description__content .jobs-box__html-content')?.innerText.trim() ||
    document.querySelector<HTMLElement>('#job-details')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.job-view-layout .jobs-description')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.show-more-less-html__markup')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="description"] [class*="html"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="job-details"] [class*="description"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('article')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="description"]')?.innerText.trim() ||
    ''

  // Fallback: try JSON-LD description if DOM extraction failed
  if (!description) {
    try {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]')
      for (const script of scripts) {
        const data = JSON.parse(script.textContent || '{}')
        const jobs = data['@graph'] ?? [data]
        for (const item of jobs) {
          if (item['@type'] === 'JobPosting' || item['@type']?.includes('JobPosting')) {
            if (item.description) {
              description = item.description.replace(/<[^>]*>/g, '').trim()
              break
            }
          }
        }
        if (description) break
      }
    } catch { /* JSON-LD parse failed, skip */ }
  }

  // ── Last resort: extract from document.title ──
  if (!title || !company) {
    const parsed = parseLinkedInPageTitle(document.title)
    if (parsed) {
      if (!title) title = parsed.title
      if (!company) company = parsed.company
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
    source: 'linkedin',
  }
}

/** Extract job title and company from LinkedIn's <title> text. */
function parseLinkedInPageTitle(t: string): { title: string; company: string } | null {
  if (!t || t.length < 3) return null

  // Strip known suffixes
  const clean = t.replace(/\s*\|\s*LinkedIn\s*$/i, '').trim()
  if (!clean) return null

  // "Company is hiring a Job Title" or "Company hiring Job Title"
  const hiring = clean.match(/^(.+?)\s+(?:is\s+)?hir(?:es|ing)\s+(?:a\s+|an\s+|for\s+)?(.+)$/i)
  if (hiring) {
    return {
      title: hiring[2].replace(/\s*on\s+LinkedIn\s*$/i, '').trim(),
      company: hiring[1].trim(),
    }
  }

  // "Job Title at Company" or "Job Title - Company" or "Job Title | Company"
  for (const sep of [' at ', ' - ', ' – ', ' — ', ' | ']) {
    const idx = clean.indexOf(sep)
    if (idx > 0) {
      const title = clean.slice(0, idx).trim()
      let company = clean.slice(idx + sep.length).trim()
      // Remove any secondary separators from company
      const parts = company.split(/\s+(?:at|-|–|—|\|)\s+/)
      company = parts[0].trim()
      if (title && company) return { title, company }
    }
  }

  return null
}
