/**
 * List-page injector: injects per-card ⊕ button and hover popup
 * on LinkedIn, Indeed, Glassdoor, Stepstone, Xing, Wellfound, Monster, Arbeitsagentur search-result pages.
 */

const ATTR        = 'data-applymate'
const POPUP_ID    = 'applymate-popup'
const BTN_CLASS   = 'applymate-card-btn'
const HOVER_DELAY = 500   // ms before popup appears (reduced for snappier preview)

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
    // LinkedIn has two layouts: public search uses base-card; signed-in search
    // uses job-card-container and Art Deco entity lockups.
    card: 'div.base-card, div.job-card-container',
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
  // LinkedIn 2026 DOM structure:
  //   div.base-card > a.base-card__full-link (overlay link) +
  //                  div.base-search-card__info >
  //                    h3.base-search-card__title (title)
  //                    h4.base-search-card__subtitle > a.hidden-nested-link (company)
  //                    div.base-search-card__metadata > span.job-search-card__location (location)
  const url =
    card.querySelector<HTMLAnchorElement>('a.base-card__full-link')?.href ||
    card.querySelector<HTMLAnchorElement>('a.job-card-container__link')?.href ||
    card.querySelector<HTMLAnchorElement>('a[href*="/jobs/view/"]')?.href ||
    ''
  if (!url) return null

  const title =
    card.querySelector<HTMLElement>('h3.base-search-card__title')?.innerText?.trim() ||
    card.querySelector<HTMLElement>('.base-search-card__title')?.innerText?.trim() ||
    card.querySelector<HTMLElement>('.artdeco-entity-lockup__title strong')?.innerText?.trim() ||
    card.querySelector<HTMLElement>('.job-card-list__title')?.innerText?.trim() ||
    // fallback: sr-only span on the overlay link
    card.querySelector<HTMLElement>('a.base-card__full-link .sr-only')?.innerText?.trim() ||
    ''

  const company =
    card.querySelector<HTMLElement>('h4.base-search-card__subtitle')?.innerText?.trim() ||
    card.querySelector<HTMLElement>('a.hidden-nested-link')?.innerText?.trim() ||
    card.querySelector<HTMLElement>('.base-search-card__subtitle')?.innerText?.trim() ||
    card.querySelector<HTMLElement>('.artdeco-entity-lockup__subtitle')?.innerText?.trim() ||
    ''

  const location =
    card.querySelector<HTMLElement>('span.job-search-card__location')?.innerText?.trim() ||
    card.querySelector<HTMLElement>('.job-search-card__location')?.innerText?.trim() ||
    card.querySelector<HTMLElement>('.artdeco-entity-lockup__caption')?.innerText?.trim() ||
    card.querySelector<HTMLElement>('.base-search-card__metadata')?.innerText?.trim()?.split('\n')[0] ||
    ''

  // Salary: not typically shown on LinkedIn list cards
  const salary =
    card.querySelector<HTMLElement>('[class*="salary"]')?.innerText?.trim() ||
    card.querySelector<HTMLElement>('[class*="compensation"]')?.innerText?.trim() ||
    ''

  if (!title || !company) return null
  return { title, company, location: location || 'Unknown', salary, url, source: 'linkedin' }
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
  const url = link?.href ||
    (jk ? `${window.location.origin}/viewjob?jk=${jk}` : window.location.href)

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

function markSaved(job: CardJob) {
  savedJobUrls.add(job.url)
  document.querySelectorAll<HTMLButtonElement>(`.${BTN_CLASS}`).forEach(btn => {
    const data = btn.getAttribute('data-applymate-job')
    if (data) {
      try {
        const parsed: CardJob = JSON.parse(data)
        if (parsed.url === job.url) {
          btn.innerHTML = `<span>✓</span>`
          btn.style.background = '#3B6D11'
        }
      } catch { /* ignore */ }
    }
  })
}

function isAlreadySaved(job: CardJob): boolean {
  return savedJobUrls.has(job.url)
}

// ── Per-card button ───────────────────────────────────────────────────────────

function injectCardButton(card: Element, job: CardJob): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.className = BTN_CLASS
  btn.title = 'Save to ApplyMate'
  btn.innerHTML = `<span>⊕</span>`
  btn.setAttribute('data-applymate-job', JSON.stringify(job))
  // Store URL for element-recycling detection in processCards()
  btn.setAttribute('data-applymate-job-url', job.url)
  // LinkedIn: also store entity URN for stable element-recycling detection
  const urn = (card as HTMLElement).getAttribute('data-entity-urn')
  if (urn) btn.setAttribute('data-applymate-urn', urn)

  btn.addEventListener('click', async (e) => {
    e.stopPropagation()
    e.preventDefault()
    log('Card button clicked:', job.title)

    btn.innerHTML = `<span>…</span>`
    btn.style.opacity = '0.6'

    try {
      const fullJob = await enrichJob(job)
      const res = await chrome.runtime.sendMessage({ type: 'SAVE_JOB', job: fullJob })
      log('SAVE_JOB response:', res)

      if (res?.success) {
        markSaved(job)
      } else {
        const msg = res?.error ?? 'Save failed'
        log('Save failed:', msg)
        if (msg.includes('Not logged in') || msg.includes('login') || msg.includes('logged') || msg.includes('Unauthorized')) {
          btn.innerHTML = `<span>⚡</span>`
          showInlineError(card as HTMLElement, 'Not logged in — click the ApplyMate icon in the toolbar to log in.')
        } else {
          btn.innerHTML = `<span>✗</span>`
        }
        btn.style.background = '#A32D2D'
        setTimeout(() => { btn.innerHTML = `<span>⊕</span>`; btn.style.background = '' }, 2000)
      }
    } catch (err: unknown) {
      log('SAVE_JOB threw:', err)
      const message = err instanceof Error ? err.message : String(err)
      btn.innerHTML = `<span>💥</span>`
      btn.style.background = '#A32D2D'
      showInlineError(card as HTMLElement, 'Extension error: ' + message + '. Try reloading the extension.')
      setTimeout(() => { btn.innerHTML = `<span>⊕</span>`; btn.style.background = '' }, 3000)
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

  function showBtn() { btn.style.opacity = '1' }
  function hideBtn() { btn.style.opacity = '' }

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

async function enrichJob(job: CardJob) {
  return new Promise<CardJob & { description: string }>((resolve) => {
    chrome.storage.local.get('currentJob', (r) => {
      const stored = r.currentJob
      const description = (stored?.url === job.url || stored?.title === job.title)
        ? (stored?.description ?? '')
        : ''
      resolve({ ...job, description })
    })
  })
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

  const cards = document.querySelectorAll<Element>(cfg.card)
  cards.forEach(card => {
    if (isIndeed && card.parentElement?.closest(`[${ATTR}="indeed"]`)) return

    if (isLinkedIn) {
      // LinkedIn 2026: use data-entity-urn as stable unique identifier.
      // div.base-card elements are recycled by React virtual scrolling.
      const urn = (card as HTMLElement).getAttribute('data-entity-urn') ||
                  card.querySelector<HTMLElement>('[data-entity-urn]')?.getAttribute('data-entity-urn')
      if (urn) {
        const existingBtn = card.querySelector<HTMLButtonElement>(`.${BTN_CLASS}`)
        if (existingBtn) {
          const storedUrn = existingBtn.getAttribute('data-applymate-urn')
          if (storedUrn === urn) return // same job, already processed
          existingBtn.remove() // different job recycled into same element
        }
      } else {
        // Fallback: check by URL
        const existingBtn = card.querySelector<HTMLButtonElement>(`.${BTN_CLASS}`)
        if (existingBtn) {
          const storedUrl = existingBtn.getAttribute('data-applymate-job-url')
          const currentLink = card.querySelector<HTMLAnchorElement>(cfg.link)
          if (storedUrl && currentLink && storedUrl === currentLink.href) return
          existingBtn.remove()
        }
      }
    } else if (isIndeed) {
      // For Indeed: use injected button as processed marker.
      const existingBtn = card.querySelector<HTMLButtonElement>(`.${BTN_CLASS}`)
      if (existingBtn) {
        const storedUrl = existingBtn.getAttribute('data-applymate-job-url')
        const currentLink = card.querySelector<HTMLAnchorElement>(cfg.link)
        if (storedUrl && currentLink && storedUrl === currentLink.href) return
        existingBtn.remove()
      }
    } else {
      // For other platforms (Greenhouse, Lever, Stepstone, etc.): simple attribute marker.
      if (card.getAttribute(ATTR)) return
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
    injectCardButton(card, job)
    attachHoverPopup(card, job)
  })
}

export function startListModeInjector() {
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
  const observer = new MutationObserver(() => {
    if (rafId !== null) return
    rafId = requestAnimationFrame(() => {
      rafId = null
      processCards(cfg)
    })
  })
  observer.observe(document.body, { childList: true, subtree: true })
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
    // Detail page: /jobs/view/NUMBER/ — never a list page (related jobs
    // section at the bottom contains base-card elements which would fool
    // the DOM check below, so reject these paths first).
    if (/\/jobs\/view\/\d+/.test(path)) return false
    return (
      path.startsWith('/jobs/search') ||
      path.startsWith('/jobs/collections') ||
      path.startsWith('/jobs/recommended') ||
      (path.startsWith('/jobs/') && !!document.querySelector(
        'div.base-card, ul.jobs-search__results-list, [data-entity-urn]'
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
