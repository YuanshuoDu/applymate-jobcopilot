import type { ScrapedJob } from '../types'

function getLinkedInDetailRoot(): ParentNode | null {
  const root = document.querySelector<HTMLElement>(
    '.jobs-search__job-details--container, .scaffold-layout__detail, .job-view-layout, .jobs-details__main-content'
  )
  if (root) return root

  // LinkedIn's 2026 split-pane rollout uses obfuscated classes. The current
  // job's canonical link and its visible "About the job" heading survive the
  // rollout, so use their smallest shared ancestor as the detail root.
  const semanticRoot = findSemanticLinkedInDetailRoot(getCurrentLinkedInJobId())
  if (semanticRoot) return semanticRoot

  return /\/jobs\/view\//i.test(window.location.pathname) ? document : null
}

function getCurrentLinkedInJobId(): string | null {
  return new URLSearchParams(window.location.search).get('currentJobId') ||
    window.location.pathname.match(/\/jobs\/view\/(\d+)/i)?.[1] ||
    null
}

function findSemanticLinkedInDetailRoot(jobId: string | null): HTMLElement | null {
  const aboutHeading = Array.from(document.querySelectorAll<HTMLElement>('h2, h3, [role="heading"]'))
    .find((element) => element.innerText.trim().toLowerCase() === 'about the job')
  if (!aboutHeading) return null

  const jobLinkSelector = jobId ? `a[href*="/jobs/view/${jobId}"]` : 'a[href*="/jobs/view/"]'
  let candidate: HTMLElement | null = aboutHeading.parentElement
  for (let depth = 0; candidate && depth < 8; depth += 1) {
    if (candidate.querySelector(jobLinkSelector)) return candidate
    candidate = candidate.parentElement
  }
  return null
}

function semanticLinkedInDescription(root: ParentNode): string {
  const aboutHeading = Array.from(root.querySelectorAll<HTMLElement>('h2, h3, [role="heading"]'))
    .find((element) => element.innerText.trim().toLowerCase() === 'about the job')
  let candidate = aboutHeading?.parentElement ?? null
  for (let depth = 0; candidate && depth < 4; depth += 1) {
    const text = candidate.innerText.trim()
    if (text.length >= 80) return text.replace(/^about the job\s*/i, '').trim()
    candidate = candidate.parentElement
  }
  return ''
}

function semanticLinkedInLocation(root: ParentNode): string | null {
  const candidates = Array.from(root.querySelectorAll<HTMLElement>('p, span'))
  for (const element of candidates) {
    const raw = element.innerText.trim()
    if (!raw || raw.length > 160 || /^about the job$/i.test(raw)) continue
    const location = raw.split(/\s*·\s*/)[0].trim()
    if (/\b(remote|hybrid|on[-\s]?site)\b/i.test(location) || /,\s*[A-Za-z]/.test(location)) {
      return location
    }
  }
  return null
}

export function scrapeLinkedIn(): ScrapedJob | null {
  const root = getLinkedInDetailRoot()
  if (!root) return null
  const query = <T extends Element>(selector: string) => root.querySelector<T>(selector)
  const queryAll = <T extends Element>(selector: string) => root.querySelectorAll<T>(selector)
  const currentJobId = getCurrentLinkedInJobId()

  // ── Title ──
  // Stable attribute-based selectors first (LinkedIn internal attributes don't change with UI refreshes),
  // then class-based fallbacks for legacy layouts.
  let title =
    // 2026+: internal data attributes
    query<HTMLElement>('[data-job-name]')?.innerText.trim() ||
    query<HTMLElement>('[aria-label*="job title" i]')?.innerText.trim() ||
    query<HTMLElement>('[aria-label*="职位名称" i]')?.innerText.trim() ||
    query<HTMLElement>('[data-test-job-title]')?.innerText.trim() ||
    (currentJobId ? query<HTMLAnchorElement>(`a[href*="/jobs/view/${currentJobId}"]`)?.innerText.trim() : '') ||
    // 2025-2026 LinkedIn top card
    query<HTMLElement>('h1[class*="title"]')?.innerText.trim() ||
    // 2024 LinkedIn unified top card
    query<HTMLElement>('h1.job-details-jobs-unified-top-card__job-title')?.innerText.trim() ||
    query<HTMLElement>('.job-details-jobs-unified-top-card__job-title h1')?.innerText.trim() ||
    // 2023 LinkedIn
    query<HTMLElement>('h1.t-24')?.innerText.trim() ||
    query<HTMLElement>('h1.top-card-layout__title')?.innerText.trim() ||
    query<HTMLElement>('h1[class*="job-title"]')?.innerText.trim() ||
    // Generic fallback: first h1 in main content
    query<HTMLElement>('main h1, h1')?.innerText.trim() ||
    null

  // ── Company ──
  // Order: targeted selectors first, then DOM-text selectors, then alt-text
  // fallbacks. a[href*="/company/"] is used first because it's the most
  // reliable — img alt selectors can match unrelated elements on panel pages.
  let company =
    query<HTMLElement>('[data-test-employer-name]')?.innerText.trim() ||
    query<HTMLElement>('[data-company-name]')?.innerText.trim() ||
    // Company name link in top card — most reliable DOM-text selector
    query<HTMLElement>('.job-details-jobs-unified-top-card__company-name a')?.innerText.trim() ||
    query<HTMLElement>('.jobs-unified-top-card__company-name a')?.innerText.trim() ||
    query<HTMLElement>('a.topcard__org-name-link')?.innerText.trim() ||
    query<HTMLElement>('.topcard__flavor a')?.innerText.trim() ||
    query<HTMLElement>('[class*="company-name"] a')?.innerText.trim() ||
    query<HTMLElement>('a[href*="/company/"]')?.innerText.trim() ||
    // Fallback: any company link near the h1
    query<HTMLElement>('h1 ~ div a[href*="/company/"]')?.innerText.trim() ||
    // Company logo alt attribute — only within job-top-card, not page-wide
    (query<HTMLImageElement>('.jobs-unified-top-card img[alt*="logo" i]')?.alt?.trim().replace(/\s*logo\s*/i, '').trim()) ||
    (query<HTMLImageElement>('.job-details-jobs-unified-top-card img[alt*="logo" i]')?.alt?.trim().replace(/\s*logo\s*/i, '').trim()) ||
    null

  // ── Location ──
  // First try stable data-testid / data attributes
  let location: string | null =
    query<HTMLElement>('[data-test-location]')?.innerText.trim() ||
    query<HTMLElement>('[data-job-location]')?.innerText.trim() ||
    null

  if (!location) {
    // Fallback: iterate through likely location elements, filtering out non-location text
    const locationEls = queryAll<HTMLElement>(
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
  location = location || semanticLinkedInLocation(root)

  // ── Salary ──
  const salaryEl =
    query<HTMLElement>('.job-details-jobs-unified-top-card__job-insight--highlight') ||
    query<HTMLElement>('[aria-label*="salary" i]') ||
    query<HTMLElement>('.salary-compensation__text') ||
    query<HTMLElement>('[class*="compensation"]') ||
    query<HTMLElement>('[class*="salary"]') ||
    null
  const salary = salaryEl?.innerText.trim() ?? null

  // ── Description ──
  // Multiple fallbacks for LinkedIn's ever-changing DOM structure.
  // The jobs-description__content and show-more-less-html patterns have been stable
  // for the longest period. #job-details was the 2023 approach.
  let description =
    query<HTMLElement>('.jobs-description__content .jobs-box__html-content')?.innerText.trim() ||
    query<HTMLElement>('#job-details')?.innerText.trim() ||
    query<HTMLElement>('.jobs-description')?.innerText.trim() ||
    query<HTMLElement>('.show-more-less-html__markup')?.innerText.trim() ||
    query<HTMLElement>('[class*="description"] [class*="html"]')?.innerText.trim() ||
    query<HTMLElement>('[class*="job-details"] [class*="description"]')?.innerText.trim() ||
    query<HTMLElement>('article')?.innerText.trim() ||
    query<HTMLElement>('[class*="description"]')?.innerText.trim() ||
    semanticLinkedInDescription(root) ||
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

  const idSelector = '[data-occludable-job-id], [data-job-id], [data-entity-urn*="jobPosting"]'
  const idEl = root instanceof Element && root.matches(idSelector)
    ? root
    : root.querySelector<HTMLElement>(idSelector)
  const rawId = currentJobId ||
    window.location.pathname.match(/\/jobs\/view\/(?:[^/?#]*-)?(\d{5,})(?:\/|$)/i)?.[1] ||
    idEl?.getAttribute('data-occludable-job-id') ||
    idEl?.getAttribute('data-job-id') ||
    idEl?.getAttribute('data-entity-urn')?.match(/(?:jobPosting:|:)(\d{5,})/i)?.[1]
  const canonicalUrl = rawId
    ? `${window.location.origin}/jobs/view/${rawId}/`
    : window.location.href

  return {
    title,
    company,
    location:    location    ?? 'Unknown',
    description: description ?? '',
    salary,
    url:    canonicalUrl,
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
