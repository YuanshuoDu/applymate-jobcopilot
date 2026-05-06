/**
 * List-page injector: injects per-card ⊕ button and hover popup
 * on LinkedIn and Indeed search-result pages.
 */

const ATTR        = 'data-applymate'
const POPUP_ID    = 'applymate-popup'
const BTN_CLASS   = 'applymate-card-btn'
const HOVER_DELAY = 1200  // ms before popup shows (prefetch runs during this wait)

interface CardJob {
  title:    string
  company:  string
  location: string
  url:      string
  source:   string
}

// ── Site-specific selectors ───────────────────────────────────────────────────

type SiteConfig = {
  card: string
  title: string
  company: string
  location: string
  link: string
}

const SITES: Record<string, SiteConfig> = {
  'linkedin.com': {
    card:     'li.jobs-search-results__list-item, li.scaffold-layout__list-item',
    title:    '.job-card-list__title, .artdeco-entity-lockup__title',
    company:  '.artdeco-entity-lockup__subtitle',
    location: '.artdeco-entity-lockup__caption, .job-card-container__metadata-item',
    link:     'a[href*="/jobs/view/"]',
  },
  'indeed.com': {
    card:     'div[class*="job_seen_beacon"], li[class*="resultContent"], td[class*="resultContent"]',
    title:    'h2.jobTitle a, .jobTitle a, [data-testid="jobTitle"] a',
    company:  '[data-testid="company-name"], .companyName, span[data-testid="company-name"]',
    location: '[data-testid="text-location"], .companyLocation',
    link:     'h2.jobTitle a, .jobTitle a, a[data-jk]',
  },
}

function getSiteConfig(): SiteConfig | null {
  const host = window.location.hostname
  for (const [key, cfg] of Object.entries(SITES)) {
    if (host.includes(key)) return cfg
  }
  return null
}

// ── Card data extraction ──────────────────────────────────────────────────────

function scrapeCard(card: Element, cfg: SiteConfig): CardJob | null {
  const title    = card.querySelector<HTMLElement>(cfg.title)?.innerText.trim()
  const company  = card.querySelector<HTMLElement>(cfg.company)?.innerText.trim()
  const location = card.querySelector<HTMLElement>(cfg.location)?.innerText.trim() ?? ''
  const link     = card.querySelector<HTMLAnchorElement>(cfg.link)

  if (!title || !company) return null

  const host   = window.location.hostname
  const source = host.includes('linkedin') ? 'linkedin' : host.includes('indeed') ? 'indeed' : 'unknown'

  return {
    title,
    company,
    location: location || 'Unknown',
    url:      link?.href ?? window.location.href,
    source,
  }
}

// ── Per-card button ───────────────────────────────────────────────────────────

function injectCardButton(card: Element, job: CardJob): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.className = BTN_CLASS
  btn.title = 'Save to ApplyMate'
  btn.innerHTML = `<span>⊕</span>`
  btn.setAttribute('data-applymate-job', JSON.stringify(job))

  // Click: save immediately
  btn.addEventListener('click', async (e) => {
    e.stopPropagation()
    e.preventDefault()
    btn.innerHTML = `<span>…</span>`
    btn.style.opacity = '0.6'
    const fullJob = await enrichJob(job)
    const res = await chrome.runtime.sendMessage({ type: 'SAVE_JOB', job: fullJob })
    if (res?.success) {
      btn.innerHTML = `<span>✓</span>`
      btn.style.background = '#3B6D11'
    } else {
      btn.innerHTML = `<span>✗</span>`
      btn.style.background = '#A32D2D'
      setTimeout(() => { btn.innerHTML = `<span>⊕</span>`; btn.style.background = '' }, 2000)
    }
  })

  // Make card position:relative so we can anchor the button
  const el = card as HTMLElement
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative'

  el.appendChild(btn)
  return btn
}

// ── Hover popup ───────────────────────────────────────────────────────────────

let hoverTimer: ReturnType<typeof setTimeout> | null = null
let currentPopupJob: CardJob | null = null

// Score cache: prefetched during the hover delay
const scoreCache = new Map<string, number | null>()
let prefetchController: AbortController | null = null

function attachHoverPopup(card: Element, job: CardJob) {
  const el = card as HTMLElement

  el.addEventListener('mouseenter', () => {
    // Start prefetching score immediately on hover (runs during the 3.5s wait)
    if (!scoreCache.has(job.url)) {
      prefetchController = new AbortController()
      fetchQuickScore(job, prefetchController.signal).then(score => {
        scoreCache.set(job.url, score)
      })
    }
    hoverTimer = setTimeout(() => showPopup(card, job), HOVER_DELAY)
  })
  el.addEventListener('mouseleave', () => {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null }
    prefetchController?.abort()
    // Don't hide immediately — let user move mouse to popup
    setTimeout(maybeHidePopup, 200)
  })
}

function showPopup(card: Element, job: CardJob) {
  // Remove old popup
  getPopup()?.remove()
  currentPopupJob = job

  const rect   = (card as HTMLElement).getBoundingClientRect()
  const popup  = document.createElement('div')
  popup.id     = POPUP_ID
  popup.innerHTML = `
    <div class="am-pop-header">
      <div class="am-pop-logo">${job.company.slice(0, 2).toUpperCase()}</div>
      <div class="am-pop-info">
        <div class="am-pop-title">${escHtml(job.title)}</div>
        <div class="am-pop-company">${escHtml(job.company)}${job.location ? ` · ${escHtml(job.location)}` : ''}</div>
      </div>
    </div>
    <div class="am-pop-score" id="am-pop-score">
      <div class="am-pop-score-label">AI 匹配度</div>
      <div class="am-pop-score-val">…</div>
    </div>
    <div class="am-pop-actions">
      <button class="am-pop-save" id="am-pop-save">⊕ 保存</button>
      <button class="am-pop-sidebar" id="am-pop-open">展开详情 →</button>
    </div>
  `

  // Position popup
  const top    = rect.bottom + window.scrollY + 8
  const left   = Math.max(8, Math.min(rect.left + window.scrollX, window.innerWidth - 272))
  popup.style.top  = `${top}px`
  popup.style.left = `${left}px`

  document.body.appendChild(popup)

  // Keep popup alive while hovering it
  popup.addEventListener('mouseenter', () => { if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null } })
  popup.addEventListener('mouseleave', () => setTimeout(maybeHidePopup, 100))

  // Save button
  document.getElementById('am-pop-save')?.addEventListener('click', async () => {
    const btn = document.getElementById('am-pop-save') as HTMLButtonElement
    btn.textContent = '…'
    btn.disabled = true
    const fullJob = await enrichJob(job)
    const res = await chrome.runtime.sendMessage({ type: 'SAVE_JOB', job: fullJob })
    if (res?.success) {
      btn.textContent = '✓ 已保存'
      btn.style.background = '#3B6D11'
    } else {
      btn.textContent = '✗ 失败'
      btn.style.background = '#A32D2D'
    }
  })

  // Open sidebar button
  document.getElementById('am-pop-open')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' })
    getPopup()?.remove()
  })

  // Show score — use cache if already prefetched, else wait
  function applyScore(score: number | null) {
    const scoreEl = document.querySelector('#am-pop-score .am-pop-score-val') as HTMLElement | null
    if (!scoreEl) return
    if (score != null) {
      const color = score >= 80 ? '#3B6D11' : score >= 60 ? '#854F0B' : '#A32D2D'
      scoreEl.textContent = `${score}%`
      scoreEl.style.color = color
    } else {
      scoreEl.textContent = '—'
    }
  }

  if (scoreCache.has(job.url)) {
    applyScore(scoreCache.get(job.url) ?? null)
  } else {
    fetchQuickScore(job).then(score => {
      scoreCache.set(job.url, score)
      applyScore(score)
    })
  }
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Fetch AI match score for the hover popup (uses cached resume from background) */
async function fetchQuickScore(job: CardJob, externalSignal?: AbortSignal): Promise<number | null> {
  try {
    const { getSettings } = await import('@/lib/storage')
    const settings = await getSettings()
    if (!settings.apiToken) return null

    // Combine external abort signal with a 3s timeout
    const timeout   = AbortSignal.timeout(3_000)
    const composite = externalSignal
      ? AbortSignal.any([externalSignal, timeout])
      : timeout

    const res = await fetch(`${settings.apiBaseUrl}/api/ai/score`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiToken}` },
      body:    JSON.stringify({ jobTitle: job.title, jobCompany: job.company, jobDescription: '' }),
      signal:  composite,
    })
    if (!res.ok) return null
    const data = await res.json()
    return typeof data.score === 'number' ? data.score : null
  } catch {
    return null
  }
}

/** Enrich card job with description from the current detail view if available */
async function enrichJob(job: CardJob) {
  // Try getting description from storage (set by detail-mode scraper)
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

function processCards(cfg: SiteConfig) {
  const cards = document.querySelectorAll<Element>(cfg.card)
  cards.forEach(card => {
    if (card.getAttribute(ATTR)) return  // already processed
    card.setAttribute(ATTR, '1')

    const job = scrapeCard(card, cfg)
    if (!job) return

    injectCardButton(card, job)
    attachHoverPopup(card, job)
  })
}

/** Start watching for new job cards (LinkedIn/Indeed are SPAs) */
export function startListModeInjector() {
  const cfg = getSiteConfig()
  if (!cfg) return

  // Initial pass
  processCards(cfg)

  // Watch DOM for dynamically loaded cards
  const observer = new MutationObserver(() => processCards(cfg))
  observer.observe(document.body, { childList: true, subtree: true })
}

/** Check if current page is a job LIST page (vs a detail page) */
export function isJobListPage(): boolean {
  const host = window.location.hostname
  const path = window.location.pathname

  if (host.includes('linkedin.com')) {
    return (
      path.startsWith('/jobs/search') ||
      path.startsWith('/jobs/collections') ||
      document.querySelector('.jobs-search-results') !== null
    )
  }
  if (host.includes('indeed.com')) {
    return (
      path.startsWith('/jobs') ||
      document.querySelector('.jobsearch-ResultsList, #mosaic-jobResults') !== null
    )
  }
  return false
}
