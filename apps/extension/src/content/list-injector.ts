/**
 * List-page injector: injects per-card ⊕ button and hover popup
 * on LinkedIn, Indeed, Glassdoor, Stepstone, Xing, Wellfound, Monster, Arbeitsagentur search-result pages.
 */
import { detectAndScrape } from '@/lib/scrapers/detect'
import { scrapeIndeedFromDocument } from '@/lib/scrapers/indeed'
import { hasUsableDescription, isJobReadyForTailoring, mergeJobDetails } from '@/lib/job-quality'
import type { ScrapedJob } from '@/lib/types'

const ATTR        = 'data-applymate'
const POPUP_ID    = 'applymate-popup'
const BTN_CLASS   = 'applymate-card-btn'
const HOVER_DELAY = 500   // ms before popup appears (reduced for snappier preview)

// Logged-in LinkedIn has begun rolling out result cards that are plain
// `div[role="button"]` controls. They contain neither a job URL nor any of the
// historical data-* identifiers, but retain this accessible dismiss control.
// Keep this narrow: it is only used as an additional card anchor, not as a
// global generic button selector.
const LINKEDIN_DISMISS_JOB_SELECTOR = 'button[aria-label^="Dismiss "][aria-label$=" job"]'
const LINKEDIN_DETAIL_SELECTOR =
  '.jobs-details__main-content, .jobs-search__job-details--container, .scaffold-layout__detail, .job-view-layout'

type ListRuntimeGlobal = typeof globalThis & {
  __applyMateListInjectorCleanup?: () => void
}

const listRuntimeGlobal = globalThis as ListRuntimeGlobal

const DEBUG = true
function log(...args: unknown[]) { if (DEBUG) console.log('[ApplyMate:list]', ...args) }

function isIndeedHost(host = window.location.hostname): boolean {
  return /(^|\.)indeed\./i.test(host)
}

interface CardJob {
  title:    string
  company:  string
  location: string
  salary:   string
  url:      string
  source:   string
}

// ── Site-specific selectors ───────────────────────────────────────────────────

type SiteConfig = {
  card: string
  title: string
  company: string
  location: string
  salary: string
  link: string
}

const SITES: Record<string, SiteConfig> = {
  'linkedin.com': {
    // LinkedIn changes class names every 3-6 months. Use attribute-based
    // selectors (data-entity-urn, data-job-id) as primary anchors, plus a
    // broad link-based fallback for any layout we haven't seen yet.
    card: '[data-occludable-job-id], [data-entity-urn], [data-job-id], div.base-card, div.job-card-container, li.jobs-search-results__list-item, li:has(a[href*="/jobs/view/"]), div[role="button"]:has(> button[aria-label^="Dismiss "][aria-label$=" job"])',
    title:    '',
    company:  '',
    location: '',
    salary:   '',
    link:     'a.base-card__full-link, a.job-card-container__link, a[href*="/jobs/view/"]',
  },
  'indeed.com': {
    // Indeed ships different wrappers by market and experiment bucket.
    // Keep selectors broad, then de-dupe nested matches in processCards().
    card: '[data-testid="slider_item"], #mosaic-provider-jobcards > ul > li, div.job_seen_beacon, td.resultContent',
    // These selectors are used by scrapeIndeedCard() directly.
    title:    '',
    company:  '',
    location: '',
    salary:   '',
    link:     'h2.jobTitle a, a[data-jk], a[href*="/viewjob"]',
  },
  'glassdoor.com': {
    card: 'li[data-test="jobListing"], li[class*="JobsList_jobListItem"], div[class*="JobCard_jobCard"]',
    title: 'a[data-test="job-title"], [class*="JobCard_jobTitle"], [class*="job-title"]',
    company: '[class*="EmployerProfile_employerName"], [data-test="employer-name"], [class*="employerName"]',
    location: '[data-test="location"], [class*="JobCard_location"], [class*="location"]',
    salary: '[data-test="detailSalary"], [class*="salary"], [class*="Salary"]',
    link: 'a[data-test="job-title"], a[class*="JobCard"], a[href*="/job-listing/"]',
  },
  'stepstone': {
    card: 'article[class*="job"], div[class*="resultlist-job"], li[class*="result-item"], article[data-at="job-item"]',
    title: '[data-at="job-item-title"], h2[class*="title"], a[class*="title"][href*="/job/"]',
    company: '[data-at="job-item-company-name"], [class*="company"], span[class*="employer"]',
    location: '[data-at="job-item-location"], [class*="location"], span[class*="city"]',
    salary: '[data-at="job-item-salary"], [class*="salary"]',
    link: 'a[href*="/job/"], a[data-at="job-item-title"]',
  },
  'xing.com': {
    card: '[data-testid="job-card"], div[class*="jobs-search__result-item"], li[class*="job-posting"]',
    title: 'a[data-testid="job-posting-title"], h2[class*="title"], a[href*="/jobs/"]',
    company: '[data-testid="company-name"], [class*="company"], [class*="employer"]',
    location: '[data-testid="location"], [class*="location"]',
    salary: '[data-testid="salary"], [class*="salary"]',
    link: 'a[data-testid="job-posting-title"], a[href*="/jobs/"]',
  },
  'wellfound.com': {
    card: 'div[class*="JobListingCard"], div[class*="job-listing"], li[class*="job"]',
    title: 'a[class*="title"], h2[class*="title"], a[href*="/jobs/"]',
    company: '[class*="company-name"], [class*="company"]',
    location: '[class*="location"]',
    salary: '[class*="salary"], [class*="compensation"]',
    link: 'a[href*="/jobs/"]',
  },
  'monster': {
    card: '[data-testid="jobTitle"], div[class*="job-card"], article[class*="job-posting"]',
    title: '[data-testid="jobTitle"] a, h2[class*="title"] a, a[class*="job-title"]',
    company: '[data-testid="company"], [class*="company-name"]',
    location: '[data-testid="job-location"], [class*="location"]',
    salary: '[data-testid="salary"], [class*="salary"]',
    link: '[data-testid="jobTitle"] a, a[class*="job-title"], a[href*="/job-openings/"]',
  },
  'arbeitsagentur.de': {
    card: '[data-cy="result-job-card"], ba-result-list-item, [class*="result-card"]',
    title: '[data-cy="result-job-card-title"], ba-result-list-item h3, [class*="card-title"]',
    company: '[data-cy="result-job-card-company"], [class*="company"]',
    location: '[data-cy="result-job-card-location"], [class*="location"]',
    salary: '[data-cy="result-job-card-salary"], [class*="salary"]',
    link: 'a[href*="/jobsuche/suche/detail/"]',
  },
  // Greenhouse public job board: boards.greenhouse.io/company
  'greenhouse.io': {
    card: '.opening, div[class*="opening"]',
    title: 'a[href*="/jobs/"]',
    company: '',   // extracted from page-level heading or URL
    location: '.location, span[class*="location"]',
    salary: '',
    link: 'a[href*="/jobs/"]',
  },
  // Lever job board: jobs.lever.co/company
  'lever.co': {
    card: '.posting, [data-qa="posting"]',
    title: '[data-qa="posting-name"], h5.posting-title, .posting-title',
    company: '',   // extracted from URL path
    location: '.location, [data-qa="posting-location"]',
    salary: '',
    link: '[data-qa="posting-name"], h5.posting-title a, a[href*="lever.co"]',
  },
  // SmartRecruiters job board
  'smartrecruiters.com': {
    card: '.job-listing, li[class*="job-listing"], [class*="JobCard"]',
    title: 'a.js-job-link h4, .job-title a, [class*="job-title" i]',
    company: '[class*="company-name" i]',
    location: '.job-location, [class*="location" i]',
    salary: '',
    link: 'a.js-job-link, a[href*="/jobs/"]',
  },
  'jobs.de': {
    card: 'li.job-list-item, div[class*="jobCard"], article[class*="job"]',
    title: '.job-list-item__title a, h2[class*="title"] a',
    company: '.job-list-item__company, [class*="company"]',
    location: '.job-list-item__location, [class*="location"]',
    salary: '[class*="salary"]',
    link: 'a[href*="/stellenanzeige/"], a[href*="/job/"]',
  },
  'localhost': {
    card: '.applymate-test-card',
    title: '.am-test-title',
    company: '.am-test-company',
    location: '.am-test-location',
    salary: '.am-test-salary',
    link: '.am-test-link',
  },
}

function getSiteConfig(): SiteConfig | null {
  const host = window.location.hostname
  if (isIndeedHost(host)) return SITES['indeed.com']
  for (const [key, cfg] of Object.entries(SITES)) {
    if (host.includes(key)) return cfg
  }
  return null
}

// ── LinkedIn-specific card extraction ────────────────────────────────────────
// Why separate: LinkedIn's innerText on the job link includes hidden sr-only text
// ("Easy Apply", "47 applicants", aria decorators), so we must target specific
// child elements rather than using the link's full text.

function scrapeLinkedInCard(card: Element): CardJob | null {
  // LinkedIn 2026 DOM: varies by rollout group.
  // Primary anchors: a[href*="/jobs/view/"] link and data-entity-urn attribute.
  const linkEl =
    card.querySelector<HTMLAnchorElement>('a[href*="/jobs/view/"]') ||
    card.querySelector<HTMLAnchorElement>('a.base-card__full-link') ||
    card.querySelector<HTMLAnchorElement>('a.job-card-container__link')

  const title =
    (linkEl?.getAttribute('aria-label')?.trim()) ||
    card.querySelector<HTMLElement>('h3.base-search-card__title')?.innerText?.trim() ||
    card.querySelector<HTMLElement>('.base-search-card__title')?.innerText?.trim() ||
    card.querySelector<HTMLElement>('.artdeco-entity-lockup__title strong')?.innerText?.trim() ||
    card.querySelector<HTMLElement>('.job-card-list__title')?.innerText?.trim() ||
    card.querySelector<HTMLElement>('a[href*="/jobs/view/"] span[aria-hidden="true"]')?.innerText?.trim() ||
    // sr-only span on overlay link (fallback)
    card.querySelector<HTMLElement>('a.base-card__full-link .sr-only')?.innerText?.trim() ||
    // Generic: first heading or strong inside card
    card.querySelector<HTMLElement>('h3, h2, strong')?.innerText?.trim() ||
    // New logged-in cards expose the title through their dismiss control.
    getLinkedInDismissTitle(card) ||
    ''

  const company =
    card.querySelector<HTMLElement>('h4.base-search-card__subtitle')?.innerText?.trim() ||
    card.querySelector<HTMLElement>('a.hidden-nested-link')?.innerText?.trim() ||
    card.querySelector<HTMLElement>('.base-search-card__subtitle')?.innerText?.trim() ||
    card.querySelector<HTMLElement>('.artdeco-entity-lockup__subtitle')?.innerText?.trim() ||
    // Generic: any link with /company/ path inside card
    card.querySelector<HTMLElement>('a[href*="/company/"]')?.innerText?.trim() ||
    getLinkedInFallbackCompany(card, title) ||
    ''

  const location =
    card.querySelector<HTMLElement>('span.job-search-card__location')?.innerText?.trim() ||
    card.querySelector<HTMLElement>('.job-search-card__location')?.innerText?.trim() ||
    card.querySelector<HTMLElement>('.artdeco-entity-lockup__caption')?.innerText?.trim() ||
    card.querySelector<HTMLElement>('.base-search-card__metadata')?.innerText?.trim()?.split('\n')[0] ||
    getLinkedInFallbackLocation(card, title, company) ||
    ''

  // Salary: not typically shown on LinkedIn list cards
  const salary =
    card.querySelector<HTMLElement>('[class*="salary"]')?.innerText?.trim() ||
    card.querySelector<HTMLElement>('[class*="compensation"]')?.innerText?.trim() ||
    ''

  if (!title || !company) return null
  const rawUrl = linkEl?.href || ''
  const jobId = getLinkedInJobId(card, rawUrl)
  const url = jobId
    ? `${window.location.origin}/jobs/view/${jobId}/`
    : getLinkedInFallbackUrl(card, title, company, location)
  return { title, company, location: location || 'Unknown', salary, url, source: 'linkedin' }
}

function asScrapedJob(job: CardJob, description = ''): ScrapedJob {
  const sources: ScrapedJob['source'][] = [
    'linkedin', 'indeed', 'glassdoor', 'wellfound', 'greenhouse', 'lever',
    'workday', 'stepstone', 'xing', 'smartrecruiters', 'ashby', 'bamboohr',
    'jobvite', 'icims', 'unknown',
  ]
  const source = sources.includes(job.source as ScrapedJob['source'])
    ? job.source as ScrapedJob['source']
    : 'unknown'
  return {
    title: job.title,
    company: job.company,
    location: job.location,
    description,
    salary: job.salary || null,
    url: job.url,
    source,
  }
}

function normalizedCardText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

function matchesCardJob(card: CardJob, detail: ScrapedJob): boolean {
  return normalizedCardText(card.title) === normalizedCardText(detail.title) &&
    normalizedCardText(card.company) === normalizedCardText(detail.company)
}

function waitForDetail(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Debug helper for list pages (injects into MAIN world so console can access) ──

function installListDebugTool() {
  const script = document.createElement('script')
  script.textContent = `
    window.__amListDebug = function () {
      var r = ['=== ApplyMate List Card Debug ===', ''];
      r.push('📍 URL: ' + location.pathname + location.search);

      // Test each card selector
      var sels = [
        '[data-entity-urn]', '[data-job-id]',
        'div.base-card', 'div.job-card-container',
        'li.jobs-search-results__list-item',
        'li:has(a[href*="/jobs/view/"])'
      ];
      r.push('');
      r.push('🔍 Card selectors:');
      for (var i = 0; i < sels.length; i++) {
        try {
          r.push('  ' + sels[i].padEnd(52) + ' = ' + document.querySelectorAll(sels[i]).length);
        } catch(e) { r.push('  ' + sels[i].padEnd(52) + ' = ERROR: ' + e.message); }
      }

      r.push('');
      r.push('🔗 a[href*="/jobs/view/"] total: ' + document.querySelectorAll('a[href*="/jobs/view/"]').length);
      r.push('🏢 a[href*="/company/"] total: ' + document.querySelectorAll('a[href*="/company/"]').length);

      // Sample first few cards
      var cards = document.querySelectorAll('[data-entity-urn]');
      if (cards.length === 0) cards = document.querySelectorAll('div.base-card');
      if (cards.length === 0) cards = document.querySelectorAll('div.job-card-container');
      if (cards.length === 0) cards = document.querySelectorAll('li:has(a[href*="/jobs/view/"])');

      r.push('');
      r.push('🧩 First cards (found via best-match selector, ' + cards.length + ' total):');
      for (var i = 0; i < Math.min(cards.length, 5); i++) {
        var c = cards[i];
        var cls = (c.className || c.getAttribute('class') || '').toString().slice(0, 60);
        var urn = c.getAttribute('data-entity-urn') || '';
        var link = c.querySelector('a[href*="/jobs/view/"]');
        var h3 = c.querySelector('h3');
        var companyEl = c.querySelector('a[href*="/company/"]');
        r.push('  [' + i + '] tag=' + c.tagName.toLowerCase() + ' class="' + cls + '"');
        r.push('      urn=' + urn + '  link=' + (link ? link.href.slice(0, 70) : 'none'));
        r.push('      h3=' + JSON.stringify(h3 ? h3.textContent.trim().slice(0, 60) : null));
        r.push('      company=' + JSON.stringify(companyEl ? companyEl.textContent.trim().slice(0, 40) : null));
      }

      var out = r.join('\\n');
      console.log(out);
      return out;
    };
  `
  script.id = 'applymate-list-debug'
  document.documentElement.appendChild(script)
  log('List debug tool installed: run __amListDebug() in console')
}

// ── Indeed-specific card extraction ──────────────────────────────────────────
// Why separate: Indeed's h2.jobTitle contains nested spans with various attrs;
// the span[title] attribute holds the cleanest title text (no decorators).
// data-jk (job key) is a stable internal ID we can use for canonical URL.

function scrapeIndeedCard(card: Element): CardJob | null {
  const el = card as HTMLElement

  // Build canonical URL from data-jk if available (more reliable than link href)
  const jk = el.dataset.jk ||
    card.querySelector<HTMLElement>('[data-jk]')?.getAttribute('data-jk') ||
    new URL(card.querySelector<HTMLAnchorElement>('a[href*="jk="]')?.href ?? window.location.href).searchParams.get('jk') ||
    ''
  const link = card.querySelector<HTMLAnchorElement>(
    'a[data-jk], a.jcs-JobTitle, h2.jobTitle a, a[data-testid="job-title"], a[href*="/viewjob"], a[href*="jk="]'
  )
  const url = jk
    ? `${window.location.origin}/viewjob?jk=${encodeURIComponent(jk)}`
    : (link?.href || window.location.href)

  // Title: span[title] attribute is the most stable — Indeed has used it since 2019.
  // Do NOT use innerText of the full h2 as it may include "new" badge, "sponsored", etc.
  const titleEl =
    card.querySelector<HTMLElement>('h2.jobTitle span[title]') ||
    card.querySelector<HTMLElement>('h2.jobTitle a span[title]') ||
    card.querySelector<HTMLElement>('a.jcs-JobTitle span[title]') ||
    card.querySelector<HTMLElement>('a[data-testid="job-title"] span[title]') ||
    card.querySelector<HTMLElement>('[data-testid="jobTitle"] span') ||
    card.querySelector<HTMLElement>('[data-testid="jobTitle"]') ||
    card.querySelector<HTMLElement>('[data-testid="job-title"]') ||
    null
  const title =
    titleEl?.getAttribute('title')?.trim() ||
    titleEl?.innerText?.trim() ||
    link?.getAttribute('aria-label')?.trim() ||
    link?.innerText?.trim() ||
    card.querySelector<HTMLElement>('h2.jobTitle')?.innerText?.trim() ||
    ''

  // Company: data-testid is consistent across Indeed's SPA versions.
  const company =
    card.querySelector<HTMLElement>('[data-testid="company-name"]')?.innerText?.trim() ||
    card.querySelector<HTMLElement>('[data-testid="companyName"]')?.innerText?.trim() ||
    card.querySelector<HTMLElement>('[data-testid="company-name"] a')?.innerText?.trim() ||
    card.querySelector<HTMLElement>('[data-company-name]')?.innerText?.trim() ||
    card.querySelector<HTMLElement>('.companyName')?.innerText?.trim() ||
    card.querySelector<HTMLElement>('[class*="companyName"]')?.innerText?.trim() ||
    ''

  // Location: data-testid is stable.
  const location =
    card.querySelector<HTMLElement>('[data-testid="text-location"]')?.innerText?.trim() ||
    card.querySelector<HTMLElement>('[data-testid="job-location"]')?.innerText?.trim() ||
    card.querySelector<HTMLElement>('[data-testid="jobLocation"]')?.innerText?.trim() ||
    card.querySelector<HTMLElement>('.companyLocation')?.innerText?.trim() ||
    card.querySelector<HTMLElement>('[class*="companyLocation"]')?.innerText?.trim() ||
    ''

  // Salary: attribute_snippet contains compensation info when available.
  const salary =
    card.querySelector<HTMLElement>('[data-testid="attribute_snippet_testid"]')?.innerText?.trim() ||
    card.querySelector<HTMLElement>('.salary-snippet-container')?.innerText?.trim() ||
    ''

  if (!title || !company) return null
  return { title, company, location: location || 'Unknown', salary, url, source: 'indeed' }
}

// ── Generic card extraction (all other platforms) ─────────────────────────────

function scrapeCard(card: Element, cfg: SiteConfig): CardJob | null {
  // Try each selector in the comma-separated list, stopping at first non-empty text
  function firstText(selector: string): string {
    for (const s of selector.split(',').map(x => x.trim())) {
      try {
        const el = card.querySelector<HTMLElement>(s)
        const text = el?.innerText?.trim() || el?.textContent?.trim() || ''
        if (text) return text
      } catch { /* ignore invalid selectors */ }
    }
    return ''
  }

  const title    = firstText(cfg.title)
  const company  = firstText(cfg.company)
  const location = firstText(cfg.location) || ''
  const salary   = firstText(cfg.salary) || ''
  const link     = card.querySelector<HTMLAnchorElement>(cfg.link.split(',')[0].trim())
    ?? card.querySelector<HTMLAnchorElement>('a[href]')

  if (!title || !company) return null

  const host   = window.location.hostname
  let source = 'unknown'
  if (host.includes('linkedin'))          source = 'linkedin'
  else if (host.includes('indeed'))       source = 'indeed'
  else if (host.includes('glassdoor'))    source = 'glassdoor'
  else if (host.includes('stepstone'))    source = 'stepstone'
  else if (host.includes('xing'))         source = 'xing'
  else if (host.includes('wellfound'))    source = 'wellfound'
  else if (host.includes('monster'))      source = 'unknown'
  else if (host.includes('arbeitsagentur')) source = 'unknown'
  else if (host.includes('jobs.de'))      source = 'unknown'
  else if (host.includes('localhost'))    source = 'linkedin'

  let url = link?.href ?? window.location.href
  if (link && !link.href.startsWith('http')) {
    try { url = new URL(link.getAttribute('href') ?? '', window.location.origin).href } catch { /* keep */ }
  }

  return { title, company, location: location || 'Unknown', salary, url, source }
}

// ── Saved-jobs cache (shared between card ⊕ and popup Save button) ──────────

const savedJobUrls = new Set<string>()

type CardButtonState = 'idle' | 'loading' | 'saved' | 'error'

function setImportantStyle(el: HTMLElement, property: string, value: string) {
  el.style.setProperty(property, value, 'important')
}

function normalizeLinkedInText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

function getLinkedInDismissTitle(card: Element): string {
  const label = card.querySelector<HTMLButtonElement>(LINKEDIN_DISMISS_JOB_SELECTOR)?.getAttribute('aria-label')?.trim() || ''
  return /^Dismiss\s+(.+?)\s+job$/i.exec(label)?.[1]?.trim() || ''
}

function isLinkedInDetailElement(element: Element): boolean {
  return !!element.closest(LINKEDIN_DETAIL_SELECTOR)
}

function findLinkedInCardForDismissButton(dismissButton: HTMLButtonElement): Element | null {
  const title = /^Dismiss\s+(.+?)\s+job$/i.exec(dismissButton.getAttribute('aria-label') || '')?.[1]?.trim()
  let candidate: Element | null = dismissButton.parentElement

  while (candidate && candidate !== document.body) {
    if (
      candidate.matches('[role="button"]') &&
      !isLinkedInDetailElement(candidate) &&
      candidate.querySelector(LINKEDIN_DISMISS_JOB_SELECTOR) === dismissButton &&
      (!title || (candidate.textContent || '').includes(title))
    ) {
      return candidate
    }
    candidate = candidate.parentElement
  }
  return null
}

function getLinkedInCardTextFragments(card: Element): string[] {
  const fragments: string[] = []
  const seen = new Set<string>()

  // Read only leaf text nodes so an outer card's aggregate text does not
  // swallow title, company, location, and status into one unusable string.
  card.querySelectorAll<HTMLElement>('span, a, strong, h2, h3, h4, p, div').forEach(element => {
    if (element.closest(`.${BTN_CLASS}`) || element.matches(LINKEDIN_DISMISS_JOB_SELECTOR)) return
    if (Array.from(element.children).some(child => (child.textContent || '').trim())) return
    const value = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim()
    if (!value || value.length > 160) return
    const key = normalizeLinkedInText(value)
    if (seen.has(key)) return
    seen.add(key)
    fragments.push(value)
  })

  return fragments
}

function isLikelyLinkedInLocation(value: string): boolean {
  return /\b(remote|hybrid|on[ -]?site|dublin|ireland|united kingdom|uk|germany|france|netherlands|belgium|sweden|denmark|norway|finland|spain|italy|poland|austria|switzerland|portugal)\b/i.test(value)
}

function isLinkedInCardMetadata(value: string, title: string): boolean {
  const normalized = normalizeLinkedInText(value)
  const normalizedTitle = normalizeLinkedInText(title)
  if (!normalized || normalized.length > 160) return true
  if (normalizedTitle && (normalized === normalizedTitle || normalized.startsWith(`${normalizedTitle} `))) return true
  return /(verified job|promoted|easy apply|saved|viewed|reposted|posted|applicants|alumni|work here|connections|\bago\b)/i.test(value)
}

function getLinkedInFallbackCompany(card: Element, title: string): string {
  const fragments = getLinkedInCardTextFragments(card)
  const normalizedTitle = normalizeLinkedInText(title)
  const titleIndex = fragments.findIndex(value => {
    const normalized = normalizeLinkedInText(value)
    return normalized === normalizedTitle || normalized.startsWith(`${normalizedTitle} `)
  })
  const candidates = titleIndex >= 0 ? fragments.slice(titleIndex + 1) : fragments

  return candidates.find(value =>
    !isLinkedInCardMetadata(value, title) && !isLikelyLinkedInLocation(value)
  ) || ''
}

function getLinkedInFallbackLocation(card: Element, title: string, company: string): string {
  const companyIndex = normalizeLinkedInText(company)
  const fragments = getLinkedInCardTextFragments(card)
  const afterCompany = companyIndex
    ? fragments.slice(Math.max(0, fragments.findIndex(value => normalizeLinkedInText(value) === companyIndex) + 1))
    : fragments
  return afterCompany.find(isLikelyLinkedInLocation) ||
    fragments.find(value => isLikelyLinkedInLocation(value) && !isLinkedInCardMetadata(value, title)) ||
    ''
}

function getLinkedInCardFingerprint(card: Element): string {
  const fragments = getLinkedInCardTextFragments(card)
  const parts = [getLinkedInDismissTitle(card), ...fragments.slice(0, 8)]
    .map(normalizeLinkedInText)
    .filter(Boolean)
  return parts.join('|').slice(0, 360)
}

function findLinkedInCardForLink(link: HTMLAnchorElement): Element | null {
  if (isLinkedInDetailElement(link)) {
    return null
  }
  const stableCard = link.closest(
    'li[data-occludable-job-id], li.jobs-search-results__list-item, div.job-card-container, div.base-card'
  )
  if (stableCard) return stableCard
  const attributedCard = link.closest('[data-job-id], [data-entity-urn]')
  if (attributedCard && attributedCard.tagName !== 'A') return attributedCard
  if (attributedCard?.parentElement && attributedCard.parentElement.tagName !== 'A') {
    return attributedCard.parentElement
  }
  const listItem = link.closest('li')
  return listItem?.querySelectorAll('a[href*="/jobs/view/"]').length === 1 ? listItem : null
}

function getLinkedInJobId(card: Element, url: string): string {
  const idSelector = '[data-occludable-job-id], [data-job-id], [data-entity-urn*="jobPosting"]'
  const attributed = card.matches(idSelector)
    ? card
    : card.querySelector(idSelector)
  const directId = attributed?.getAttribute('data-occludable-job-id') ||
    attributed?.getAttribute('data-job-id')
  if (directId) return directId
  const urn = attributed?.getAttribute('data-entity-urn') || ''
  const urnId = urn.match(/(?:jobPosting:|:)(\d{5,})/i)?.[1]
  if (urnId) return urnId
  return url.match(/\/jobs\/view\/(?:[^/?#]*-)?(\d{5,})(?:[/?#]|$)/i)?.[1] || ''
}

function getLinkedInJobKey(card: Element, url: string): string {
  const urlId = getLinkedInJobId(card, url)
  if (urlId) return `linkedin:${urlId}`
  const fingerprint = getLinkedInCardFingerprint(card)
  return fingerprint ? `linkedin:card:${fingerprint}` : `linkedin:${url}`
}

function getCurrentLinkedInJobId(): string {
  const currentJobId = new URLSearchParams(window.location.search).get('currentJobId')
  if (currentJobId) return currentJobId
  const pathId = window.location.pathname.match(/\/jobs\/view\/(?:[^/?#]*-)?(\d{5,})(?:[/?#]|$)/i)?.[1]
  if (pathId) return pathId
  const detailRoot = document.querySelector<HTMLElement>(LINKEDIN_DETAIL_SELECTOR)
  const linkedId = detailRoot?.querySelector<HTMLAnchorElement>('a[href*="/jobs/view/"]')?.href || ''
  return getLinkedInJobId(detailRoot || document.documentElement, linkedId)
}

function isSelectedLinkedInCard(card: Element, title: string): boolean {
  if (card.matches('[aria-selected="true"], [aria-current="true"]') ||
      card.querySelector('[aria-selected="true"], [aria-current="true"]')) {
    return true
  }
  const detailTitle = document.querySelector<HTMLElement>(
    `${LINKEDIN_DETAIL_SELECTOR} h1.job-details-jobs-unified-top-card__job-title, ` +
    `${LINKEDIN_DETAIL_SELECTOR} h1.t-24.t-bold, ${LINKEDIN_DETAIL_SELECTOR} h1[class*="title"]`
  )?.innerText?.trim() || ''
  return Boolean(detailTitle && normalizeLinkedInText(detailTitle) === normalizeLinkedInText(title))
}

function getLinkedInFallbackUrl(card: Element, title: string, company: string, location: string): string {
  const selectedJobId = getCurrentLinkedInJobId()
  if (selectedJobId && isSelectedLinkedInCard(card, title)) {
    return `${window.location.origin}/jobs/view/${selectedJobId}/`
  }

  // The current rollout exposes no per-card href. Preserve the actual search
  // page and give each card a stable fragment so saved jobs remain distinct
  // instead of every plus button saving the same selected job.
  const fallback = new URL(window.location.href)
  const fingerprint = getLinkedInCardFingerprint(card) || `${title}|${company}|${location}`
  fallback.hash = `applymate-card=${encodeURIComponent(fingerprint.slice(0, 360))}`
  return fallback.href
}

function collectLinkedInCards(): Element[] {
  const cards: Element[] = []
  const seen = new Set<Element>()
  const addCard = (card: Element | null) => {
    if (!card || seen.has(card)) return
    seen.add(card)
    cards.push(card)
  }
  document.querySelectorAll<HTMLAnchorElement>('a[href*="/jobs/view/"]').forEach(link => {
    addCard(findLinkedInCardForLink(link))
  })
  document.querySelectorAll<HTMLButtonElement>(LINKEDIN_DISMISS_JOB_SELECTOR).forEach(dismissButton => {
    addCard(findLinkedInCardForDismissButton(dismissButton))
  })
  return cards
}

function collectIndeedCards(): Element[] {
  const cards: Element[] = []
  const seen = new Set<Element>()
  document.querySelectorAll<HTMLAnchorElement>('a[data-jk], a[href*="/viewjob"]').forEach(link => {
    if (link.closest('#jobsearch-ViewjobPaneWrapper, #vjs-container, #vjs-details, #viewJobSSRRoot')) return
    const card = link.closest('[data-testid="slider_item"]') ||
      link.closest('#mosaic-provider-jobcards > ul > li') ||
      link.closest('div.job_seen_beacon') ||
      link.closest('td.resultContent')
    if (!card || seen.has(card)) return
    seen.add(card)
    cards.push(card)
  })
  return cards
}

function getIndeedJobKey(card: Element, url: string): string {
  const cardJobKey = (card as HTMLElement).dataset.jk ||
    card.querySelector<HTMLElement>('[data-jk]')?.getAttribute('data-jk') || ''
  if (cardJobKey) return `indeed:${cardJobKey}`
  try {
    const parsed = new URL(url, window.location.origin)
    const jobKey = parsed.searchParams.get('jk') || parsed.searchParams.get('vjk')
    if (jobKey) return `indeed:${jobKey}`
  } catch { /* fall through to URL identity */ }
  return `indeed:${url}`
}

function styleCardButton(btn: HTMLButtonElement) {
  const isLinkedIn = window.location.hostname.includes('linkedin')
  const isIndeed = isIndeedHost()
  const styles: Record<string, string> = {
    position: 'absolute',
    top: isIndeed ? 'auto' : '50%',
    bottom: isIndeed ? '12px' : 'auto',
    right: isLinkedIn ? '42px' : '12px',
    transform: isIndeed ? 'none' : 'translateY(-50%)',
    'z-index': '2147483646',
    width: '30px',
    height: '30px',
    margin: '0',
    padding: '0',
    border: 'none',
    'border-radius': '9999px',
    color: '#fff',
    display: 'flex',
    'align-items': 'center',
    'justify-content': 'center',
    'font-size': '17px',
    'line-height': '1',
    'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    'box-shadow': '0 2px 10px rgba(79, 70, 229, 0.42)',
    cursor: 'pointer',
    opacity: '1',
    visibility: 'visible',
    'pointer-events': 'auto',
  }
  for (const [property, value] of Object.entries(styles)) {
    setImportantStyle(btn, property, value)
  }
}

function renderCardButtonState(btn: HTMLButtonElement, state: CardButtonState) {
  const visuals: Record<CardButtonState, { icon: string; background: string; opacity: string; title: string }> = {
    idle: { icon: '＋', background: '#4F46E5', opacity: '1', title: 'Save to ApplyMate' },
    loading: { icon: '…', background: '#4F46E5', opacity: '0.68', title: 'Saving to ApplyMate' },
    saved: { icon: '✓', background: '#3B6D11', opacity: '1', title: 'Saved to ApplyMate' },
    error: { icon: '!', background: '#A32D2D', opacity: '1', title: 'Save failed — click to retry' },
  }
  const visual = visuals[state]
  btn.innerHTML = `<span aria-hidden="true">${visual.icon}</span>`
  btn.title = visual.title
  btn.setAttribute('aria-label', visual.title)
  btn.dataset.applymateState = state
  setImportantStyle(btn, 'background', visual.background)
  setImportantStyle(btn, 'opacity', visual.opacity)
}

function restoreCardButton(btn: HTMLButtonElement) {
  btn.disabled = false
  delete btn.dataset.applymateBusy
  renderCardButtonState(btn, 'idle')
}

function markSaved(job: CardJob) {
  savedJobUrls.add(job.url)
  document.querySelectorAll<HTMLButtonElement>(`.${BTN_CLASS}`).forEach(btn => {
    const data = btn.getAttribute('data-applymate-job')
    if (data) {
      try {
        const parsed: CardJob = JSON.parse(data)
        if (parsed.url === job.url) {
          btn.disabled = true
          delete btn.dataset.applymateBusy
          renderCardButtonState(btn, 'saved')
        }
      } catch { /* ignore */ }
    }
  })
}

function isAlreadySaved(job: CardJob): boolean {
  return savedJobUrls.has(job.url)
}

// ── Per-card button ───────────────────────────────────────────────────────────

function injectCardButton(card: Element, job: CardJob, jobKey = job.url): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.className = BTN_CLASS
  btn.type = 'button'
  btn.dataset.applymateRole = 'list-save'
  if (isIndeedHost()) btn.dataset.applymateSite = 'indeed'
  styleCardButton(btn)
  renderCardButtonState(btn, isAlreadySaved(job) ? 'saved' : 'idle')
  btn.disabled = isAlreadySaved(job)
  btn.setAttribute('data-applymate-job', JSON.stringify(job))
  // Store URL for element-recycling detection in processCards()
  btn.setAttribute('data-applymate-job-url', job.url)
  btn.setAttribute('data-applymate-job-key', jobKey)

  btn.addEventListener('click', async (e) => {
    e.stopPropagation()
    e.stopImmediatePropagation()
    e.preventDefault()
    if (btn.dataset.applymateBusy === 'true' || isAlreadySaved(job)) return
    log('Card button clicked:', job.title)

    btn.dataset.applymateBusy = 'true'
    btn.disabled = true
    renderCardButtonState(btn, 'loading')

    try {
      const fullJob = await resolveJobForSave(card, job)
      if (!fullJob) {
        renderCardButtonState(btn, 'error')
        showInlineError(
          card as HTMLElement,
          'Could not read the full job description. This job was not saved — open its details and retry.',
        )
        setTimeout(() => restoreCardButton(btn), 3_500)
        return
      }
      const res = await chrome.runtime.sendMessage({ type: 'SAVE_JOB', job: fullJob })
      log('SAVE_JOB response:', res)

      if (res?.success) {
        markSaved(job)
      } else {
        const msg = res?.error ?? 'Save failed'
        log('Save failed:', msg)
        if (msg.includes('Not logged in') || msg.includes('login') || msg.includes('logged') || msg.includes('Unauthorized')) {
          showInlineError(card as HTMLElement, 'Not logged in — click the ApplyMate icon in the toolbar to log in.')
        } else {
          showInlineError(card as HTMLElement, msg)
        }
        renderCardButtonState(btn, 'error')
        setTimeout(() => restoreCardButton(btn), 2000)
      }
    } catch (err: unknown) {
      log('SAVE_JOB threw:', err)
      const message = err instanceof Error ? err.message : String(err)
      renderCardButtonState(btn, 'error')
      showInlineError(card as HTMLElement, 'Extension error: ' + message + '. Try reloading the extension.')
      setTimeout(() => restoreCardButton(btn), 3000)
    }
  })

  const el = card as HTMLElement
  // Only force position:relative if the card is currently static.
  // LinkedIn and Indeed cards are already position:relative in their own CSS —
  // touching their style is unnecessary and slightly increases detection risk.
  if (getComputedStyle(el).position === 'static') {
    el.style.setProperty('position', 'relative', 'important')
  }
  el.appendChild(btn)

  function showBtn() { setImportantStyle(btn, 'opacity', '1') }
  function hideBtn() {
    setImportantStyle(btn, 'opacity', btn.dataset.applymateState === 'loading' ? '0.68' : '1')
  }

  el.addEventListener('mouseenter', showBtn)
  el.addEventListener('mouseleave', hideBtn)
  btn.addEventListener('mouseenter', showBtn)
  btn.addEventListener('focus', showBtn)
  btn.addEventListener('blur', hideBtn)

  ;(btn as any).__am_cleanup = () => {
    el.removeEventListener('mouseenter', showBtn)
    el.removeEventListener('mouseleave', hideBtn)
  }

  return btn
}

// ── Hover popup (lightweight info preview — NO save, NO score) ──────────────

let hoverTimer: ReturnType<typeof setTimeout> | null = null
let currentPopupJob: CardJob | null = null

function attachHoverPopup(card: Element, job: CardJob) {
  const el = card as HTMLElement

  el.addEventListener('mouseenter', () => {
    hoverTimer = setTimeout(() => showPopup(card, job), HOVER_DELAY)
  })
  el.addEventListener('mouseleave', () => {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null }
    setTimeout(maybeHidePopup, 200)
  })
}

const SOURCE_CLASS: Record<string, string> = {
  linkedin:        'am-src-linkedin',
  indeed:          'am-src-indeed',
  glassdoor:       'am-src-glassdoor',
  stepstone:       'am-src-stepstone',
  xing:            'am-src-xing',
  wellfound:       'am-src-wellfound',
  greenhouse:      'am-src-greenhouse',
  lever:           'am-src-lever',
  workday:         'am-src-workday',
  smartrecruiters: 'am-src-smartrecruiters',
  ashby:           'am-src-ashby',
  bamboohr:        'am-src-bamboohr',
  jobvite:         'am-src-jobvite',
  icims:           'am-src-icims',
}

const SOURCE_LABEL: Record<string, string> = {
  linkedin:        'LinkedIn',
  indeed:          'Indeed',
  glassdoor:       'Glassdoor',
  stepstone:       'Stepstone',
  xing:            'Xing',
  wellfound:       'Wellfound',
  greenhouse:      'Greenhouse',
  lever:           'Lever',
  workday:         'Workday',
  smartrecruiters: 'SmartRecruiters',
  ashby:           'Ashby',
  bamboohr:        'BambooHR',
  jobvite:         'Jobvite',
  icims:           'iCIMS',
}

function showPopup(card: Element, job: CardJob) {
  getPopup()?.remove()
  currentPopupJob = job

  const rect    = (card as HTMLElement).getBoundingClientRect()
  // Smaller popup: only info, no score, no save button
  const POPUP_H = 130
  const POPUP_W = 260

  const spaceBelow = window.innerHeight - rect.bottom
  const placeAbove = spaceBelow < POPUP_H + 12 && rect.top > POPUP_H + 12
  const topAbs     = placeAbove
    ? rect.top  + window.scrollY - POPUP_H - 8
    : rect.bottom + window.scrollY + 8

  const leftAbs = Math.max(8, Math.min(rect.left + window.scrollX, window.innerWidth - POPUP_W - 8))

  const srcClass = SOURCE_CLASS[job.source] ?? 'am-src-unknown'
  const srcLabel = SOURCE_LABEL[job.source] ?? (() => {
    const h = window.location.hostname
    if (h.includes('monster'))        return 'Monster'
    if (h.includes('arbeitsagentur')) return 'Arbeitsagentur'
    if (h.includes('jobs.de'))        return 'Jobs.de'
    return 'Job Board'
  })()

  const popup  = document.createElement('div')
  popup.id     = POPUP_ID
  popup.innerHTML = `
    <div class="am-pop-inner">
      <div class="am-pop-header">
        <div class="am-pop-logo">${escHtml(job.company.slice(0, 2).toUpperCase())}</div>
        <div class="am-pop-info">
          <div class="am-pop-title">${escHtml(job.title)}</div>
          <div class="am-pop-company">${escHtml(job.company)}${job.location && job.location !== 'Unknown' ? ` · ${escHtml(job.location)}` : ''}</div>
        </div>
        <span class="am-pop-source ${escHtml(srcClass)}">${escHtml(typeof srcLabel === 'string' ? srcLabel : 'Job')}</span>
      </div>
      ${job.salary ? `<div class="am-pop-salary"><span class="am-pop-salary-icon">💰</span> ${escHtml(job.salary)}</div>` : ''}
      <div class="am-pop-footer">
        <a class="am-pop-link" href="${escHtml(job.url)}" target="_blank" rel="noreferrer">View on ${escHtml(typeof srcLabel === 'string' ? srcLabel : 'site')} ↗</a>
      </div>
    </div>
  `

  Object.assign(popup.style, { top: `${topAbs}px`, left: `${leftAbs}px` })
  document.body.appendChild(popup)

  popup.addEventListener('mouseenter', () => { if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null } })
  popup.addEventListener('mouseleave', () => setTimeout(maybeHidePopup, 100))
}

function maybeHidePopup() {
  const popup = getPopup()
  if (!popup) return
  if (popup.matches(':hover')) return
  popup.remove()
  currentPopupJob = null
}

function getPopup(): HTMLElement | null {
  return document.getElementById(POPUP_ID)
}

// ── Inline error toast ────────────────────────────────────────────────────────

function showInlineError(card: HTMLElement, message: string) {
  const existing = document.getElementById('applymate-toast')
  if (existing) existing.remove()

  const toast = document.createElement('div')
  toast.id = 'applymate-toast'
  toast.textContent = message
  Object.assign(toast.style, {
    position: 'fixed', bottom: '80px', right: '24px', zIndex: '2147483647',
    padding: '10px 14px', background: '#1a1a2e', color: '#fff',
    borderRadius: '8px', fontSize: '12px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)', opacity: '0',
    transition: 'opacity 0.3s', maxWidth: '380px',
  })
  document.body.appendChild(toast)
  requestAnimationFrame(() => { toast.style.opacity = '1' })
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300) }, 4000)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

async function fetchIndeedDetails(job: CardJob): Promise<ScrapedJob | null> {
  if (job.source !== 'indeed' || !/\/viewjob/i.test(job.url)) return null
  try {
    const response = await fetch(job.url, {
      credentials: 'include',
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) return null
    const html = await response.text()
    const parsed = new DOMParser().parseFromString(html, 'text/html')
    const scraped = scrapeIndeedFromDocument(parsed, response.url)
    if (!scraped) return null
    return mergeJobDetails(asScrapedJob(job), scraped)
  } catch (error) {
    log('Indeed detail fetch failed:', error)
    return null
  }
}

async function readCurrentMatchingDetail(job: CardJob): Promise<ScrapedJob | null> {
  const detail = detectAndScrape()
  if (!detail || !matchesCardJob(job, detail)) return null
  return mergeJobDetails(asScrapedJob(job), detail)
}

async function selectLinkedInCardAndReadDetails(card: Element, job: CardJob): Promise<ScrapedJob | null> {
  // The newest LinkedIn result cards intentionally omit their job IDs and
  // links. The only reliable way to associate a JD with that card is to open
  // its own detail pane, then verify both title and company before saving.
  const target = card.matches('[role="button"]') ? card : card.querySelector('[role="button"]') ?? card
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))

  let best: ScrapedJob | null = null
  for (const delay of [250, 400, 650, 900, 1_200]) {
    await waitForDetail(delay)
    const detail = await readCurrentMatchingDetail(job)
    if (!detail) continue
    best = best ? mergeJobDetails(best, detail) : detail
    if (isJobReadyForTailoring(best)) return best
  }
  return best
}

/**
 * A list card only has summary data. Resolve a verified detail record before
 * saving so a successful checkmark never masks a job that cannot be tailored.
 */
async function resolveJobForSave(card: Element, job: CardJob): Promise<ScrapedJob | null> {
  const currentDetail = await readCurrentMatchingDetail(job)
  if (currentDetail && isJobReadyForTailoring(currentDetail)) return currentDetail

  const fetchedIndeed = await fetchIndeedDetails(job)
  if (fetchedIndeed && isJobReadyForTailoring(fetchedIndeed)) return fetchedIndeed

  if (job.source === 'linkedin') {
    const selectedDetail = await selectLinkedInCardAndReadDetails(card, job)
    if (selectedDetail && isJobReadyForTailoring(selectedDetail)) return selectedDetail
  }

  return null
}

// ── Main observer loop ────────────────────────────────────────────────────────

function scrapeGreenhouseCard(card: Element): CardJob | null {
  const link = card.querySelector<HTMLAnchorElement>('a[href*="/jobs/"]')
  const title = link?.innerText?.trim() || ''
  if (!title) return null
  // Company from page heading, logo alt, or URL slug
  const company =
    document.querySelector<HTMLElement>('.company-name, [class*="company-name"]')?.innerText.trim() ||
    (document.querySelector<HTMLImageElement>('img.company-logo, img[class*="logo"]')?.alt?.trim().replace(/ logo$/i, '').trim()) ||
    window.location.pathname.split('/').filter(Boolean)[0] ||
    'Unknown'
  const location = card.querySelector<HTMLElement>('.location, span[class*="location"]')?.innerText.trim() || ''
  const url = link?.href || window.location.href
  return { title, company, location: location || 'Unknown', salary: '', url, source: 'greenhouse' }
}

function scrapeLeverCard(card: Element): CardJob | null {
  const titleEl = card.querySelector<HTMLAnchorElement>('[data-qa="posting-name"], h5.posting-title a, .posting-title a')
  const title = titleEl?.innerText?.trim() ||
    card.querySelector<HTMLElement>('h5.posting-title, .posting-title')?.innerText.trim() ||
    ''
  if (!title) return null
  // Company: from URL path (jobs.lever.co/company-slug/uuid)
  const company = window.location.pathname.split('/').filter(Boolean)[0] || 'Unknown'
  const location = card.querySelector<HTMLElement>('.location, [data-qa="posting-location"]')?.innerText.trim() || ''
  const url = (titleEl as HTMLAnchorElement)?.href ||
    card.querySelector<HTMLAnchorElement>('a[href]')?.href || window.location.href
  return { title, company, location: location || 'Unknown', salary: '', url, source: 'lever' }
}

function processCards(cfg: SiteConfig) {
  const host = window.location.hostname
  const isLinkedIn    = host.includes('linkedin')
  const isIndeed      = isIndeedHost(host)
  const isGreenhouse  = host.includes('greenhouse.io')
  const isLever       = host.includes('lever.co')

  const cards = isLinkedIn
    ? collectLinkedInCards()
    : isIndeed
      ? collectIndeedCards()
      : Array.from(document.querySelectorAll<Element>(cfg.card))
  if (cards.length === 0 && isLinkedIn) {
    // Fallback: find cards via job links (always works on LinkedIn)
    processCardsViaJobLinks()
    return
  }

  let processed = 0
  let covered = 0
  cards.forEach(card => {
    if (isIndeed && card.parentElement?.closest(`[${ATTR}="indeed"]`)) return

    if (isLinkedIn) {
      const currentLink = card.querySelector<HTMLAnchorElement>(cfg.link)
      const currentKey = getLinkedInJobKey(card, currentLink?.href || '')
      const existingBtn = card.querySelector<HTMLButtonElement>(`.${BTN_CLASS}`)
      if (existingBtn) {
        if (existingBtn.getAttribute('data-applymate-job-key') === currentKey) {
          covered++
          return
        }
        existingBtn.remove()
      }
    } else if (isIndeed) {
      const existingBtn = card.querySelector<HTMLButtonElement>(`.${BTN_CLASS}`)
      if (existingBtn) {
        const currentLink = card.querySelector<HTMLAnchorElement>(cfg.link)
        const currentKey = getIndeedJobKey(card, currentLink?.href || '')
        if (existingBtn.getAttribute('data-applymate-job-key') === currentKey) {
          covered++
          return
        }
        existingBtn.remove()
      }
    } else {
      if (card.getAttribute(ATTR)) {
        covered++
        return
      }
      card.setAttribute(ATTR, '1')
    }

    let job: CardJob | null = null
    if (isLinkedIn) {
      job = scrapeLinkedInCard(card)
    } else if (isIndeed) {
      job = scrapeIndeedCard(card)
    } else if (isGreenhouse) {
      job = scrapeGreenhouseCard(card)
    } else if (isLever) {
      job = scrapeLeverCard(card)
    } else {
      job = scrapeCard(card, cfg)
    }

    if (!job) {
      log('Card scraped but no job data:', (card as HTMLElement).className?.slice(0, 60))
      return
    }

    log('Processing card:', job.title, '@', job.company)
    if (isIndeed) (card as HTMLElement).setAttribute(ATTR, 'indeed')
    const jobKey = isLinkedIn
      // Reuse the card's DOM identity rather than the scraped URL: the
      // current selected card may borrow `currentJobId` while linkless cards
      // use a stable fingerprint, and mixing the two causes observer loops.
      ? getLinkedInJobKey(card, card.querySelector<HTMLAnchorElement>(cfg.link)?.href || '')
      : isIndeed
        ? getIndeedJobKey(card, job.url)
        : job.url
    injectCardButton(card, job, jobKey)
    attachHoverPopup(card, job)
    processed++
  })
  if (processed > 0) log(`✅ Injected ${processed} card buttons`)
  if (processed === 0 && covered === 0 && isLinkedIn) processCardsViaJobLinks()
}

// ── Fallback: find cards via job view links (always works on LinkedIn) ────

function processCardsViaJobLinks() {
  const cards = collectLinkedInCards()
  log(`processCardsViaJobLinks: found ${cards.length} canonical cards`)
  let processed = 0

  cards.forEach(card => {
    const link = card.querySelector<HTMLAnchorElement>('a[href*="/jobs/view/"]')
    const key = getLinkedInJobKey(card, link?.href || '')
    const existing = card.querySelector<HTMLButtonElement>(`.${BTN_CLASS}`)
    if (existing?.getAttribute('data-applymate-job-key') === key) return
    existing?.remove()
    const job = scrapeLinkedInCard(card)
    if (!job) return
    injectCardButton(card, job, key)
    attachHoverPopup(card, job)
    processed++
  })

  if (processed > 0) log(`✅ processCardsViaJobLinks: injected ${processed} card buttons`)
}

export function startListModeInjector() {
  listRuntimeGlobal.__applyMateListInjectorCleanup?.()
  const cfg = getSiteConfig()
  if (!cfg) {
    log('No site config for host:', window.location.hostname)
    return
  }
  log('Starting list injector for:', window.location.hostname, 'card selector:', cfg.card)

  processCards(cfg)

  // RAF debounce: LinkedIn and Indeed trigger dozens of DOM mutations per second
  // (virtual scrolling, ad injection, lazy-loaded images). Without debounce,
  // processCards() would run on every micro-change, wasting CPU.
  let rafId: number | null = null
  let disposed = false
  const observer = new MutationObserver(() => {
    if (rafId !== null) return
    rafId = requestAnimationFrame(() => {
      rafId = null
      processCards(cfg)
    })
  })
  observer.observe(document.body, { childList: true, subtree: true })

  // Staggered retries: LinkedIn loads cards via AJAX, sometimes after our first scan.
  // Re-scanning at increasing intervals catches late-loading cards reliably.
  const retryTimers = [2000, 5000, 10000].map(delay => setTimeout(() => {
      if (disposed) return
      log(`Retry scan at ${delay}ms...`)
      processCards(cfg)
    }, delay))
  listRuntimeGlobal.__applyMateListInjectorCleanup = () => {
    disposed = true
    observer.disconnect()
    if (rafId !== null) cancelAnimationFrame(rafId)
    retryTimers.forEach(timer => clearTimeout(timer))
  }
}

// ── Listen for login/logout from popup ──────────────────────────────────────

window.addEventListener('applymate:logout', () => {
  log('Logout event — clearing saved state')
  savedJobUrls.clear()
  document.querySelectorAll<HTMLButtonElement>(`.${BTN_CLASS}`).forEach(btn => {
    btn.innerHTML = `<span>⊕</span>`
    btn.style.background = ''
  })
  getPopup()?.remove()
  currentPopupJob = null
})

window.addEventListener('applymate:login', () => {
  log('Login event — ready to save')
  document.querySelectorAll<HTMLButtonElement>(`.${BTN_CLASS}`).forEach(btn => {
    if (btn.style.background === 'rgb(163, 45, 45)') {
      btn.innerHTML = `<span>⊕</span>`
      btn.style.background = ''
    }
  })
})

export function isJobListPage(): boolean {
  const host = window.location.hostname
  const path = window.location.pathname

  if (host.includes('linkedin.com')) {
    // Detail page: /jobs/view/... (with or without slug) — never a list page
    // (related jobs section at the bottom contains base-card elements which
    // would fool the DOM check below, so reject these paths first).
    if (path.startsWith('/jobs/view/')) return false
    return (
      path.startsWith('/jobs/search') ||
      path.startsWith('/jobs/collections') ||
      path.startsWith('/jobs/recommended') ||
      ((path === '/jobs' || path.startsWith('/jobs/')) && !!document.querySelector(
        `div.base-card, ul.jobs-search__results-list, [data-entity-urn], [data-job-id], ${LINKEDIN_DISMISS_JOB_SELECTOR}`
      ))
    )
  }
  if (isIndeedHost(host)) {
    // Detail page: /viewjob?jk=... — never a list page.
    if (path.startsWith('/viewjob')) return false
    return (
      path.startsWith('/jobs') ||
      !!document.querySelector('.jobsearch-ResultsList, #mosaic-jobResults, #mosaic-provider-jobcards, [data-testid="slider_item"], div.job_seen_beacon, td.resultContent')
    )
  }
  if (host.includes('glassdoor.com')) {
    return (
      path.startsWith('/Job/') ||
      path.startsWith('/Jobs/') ||
      !!document.querySelector('li[data-test="jobListing"], li[class*="JobsList_jobListItem"]')
    )
  }
  if (host.includes('stepstone')) {
    return (
      path.includes('/jobs') ||
      path.includes('/search') ||
      !!document.querySelector('article[class*="job"], div[class*="resultlist"], article[data-at="job-item"]')
    )
  }
  if (host.includes('xing.com')) {
    return (
      path.includes('/jobs') ||
      !!document.querySelector('[data-testid="job-card"], div[class*="jobs-search"]')
    )
  }
  if (host.includes('wellfound.com')) {
    return (
      path.includes('/jobs') ||
      !!document.querySelector('div[class*="JobListingCard"], div[class*="job-listing"]')
    )
  }
  if (host.includes('greenhouse.io')) {
    // Greenhouse public board: boards.greenhouse.io/company (no /jobs/ prefix = list page)
    // boards.greenhouse.io/company/jobs/123 = detail page
    const pathParts = window.location.pathname.split('/').filter(Boolean)
    // List page: /company or /company/ (1 or 0 path parts after stripping slug)
    // Detail page: /company/jobs/123 (3 parts)
    if (pathParts.length <= 1) return true
    if (pathParts.length >= 3 && pathParts[1] === 'jobs') return false
    return !!document.querySelector('.opening, [class*="opening"]')
  }
  if (host.includes('lever.co')) {
    // Lever list: jobs.lever.co/company (1 path segment = company slug)
    // Lever detail: jobs.lever.co/company/uuid (2 path segments)
    const pathParts = window.location.pathname.split('/').filter(Boolean)
    if (pathParts.length <= 1) return true
    return false
  }
  if (host.includes('smartrecruiters.com')) {
    return path.includes('/jobs') || !!document.querySelector('.job-listing, [class*="JobCard"]')
  }
  if (host.includes('monster') || host.includes('jobs.de') || host.includes('arbeitsagentur')) {
    // These sites: always try list mode (no reliable URL pattern difference between list/detail)
    return !!document.querySelector('[data-testid="jobTitle"], [data-cy="result-job-card"], li.job-list-item, article[class*="job-posting"]')
  }
  if (host.includes('localhost')) {
    return !!document.querySelector('.applymate-test-card')
  }
  return false
}
