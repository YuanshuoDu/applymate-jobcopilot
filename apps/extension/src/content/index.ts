/**
 * ApplyMate AI — Content Script
 * Two modes:
 *  • List page  → per-card ⊕ button + click-to-open action card
 *  • Detail page → inline Save to ApplyMate near the job action buttons
 */
import { detectAndScrape } from '@/lib/scrapers/detect'
import { startListModeInjector, isJobListPage, markJobSaved } from './list-injector'
import { tryInjectAutoFillButton, removeAutoFillButton, applyFieldValues, updateButtonState } from './form-injector'
import { findDetailActionHost, mountDetailButtonContainer } from './detail-button-placement'
import { detectAndScanForms } from '../lib/form-filler/detectors/detect'
import { generateId } from '../lib/form-filler/form-scanner'
import { openUploadPicker } from '../lib/form-filler/auto-fill'
import type { ExtensionSettings, ScrapedJob } from '@/lib/types'
import { isJobReadyForTailoring, mergeJobDetails } from '@/lib/job-quality'
import { getJobIdentity } from '@/lib/job-identity'

type ContentRuntime = {
  marker?: string
  isAlive: () => boolean
  dispose: () => void
}

type ContentRuntimeGlobal = typeof globalThis & {
  __applyMateContentBuild?: string
  __applyMateContentScriptState?: 'loading' | 'ready'
  __applyMateContentRuntime?: ContentRuntime
  __applyMateListInjectorCleanup?: () => void
  __applyMateJobUiCleanup?: () => void
}

const contentRuntimeGlobal = globalThis as ContentRuntimeGlobal
contentRuntimeGlobal.__applyMateContentScriptState = 'loading'
const contentRuntime: ContentRuntime = {
  marker: contentRuntimeGlobal.__applyMateContentBuild,
  isAlive: () => {
    try { return Boolean(chrome.runtime.id && chrome.runtime.getManifest().version) } catch { return false }
  },
  dispose: () => {
    contentRuntimeGlobal.__applyMateListInjectorCleanup?.()
    contentRuntimeGlobal.__applyMateJobUiCleanup?.()
  },
}
contentRuntimeGlobal.__applyMateContentRuntime = contentRuntime

const BUTTON_ID   = 'applymate-save-btn'
const TOAST_ID    = 'applymate-toast'

// The dashboard only needs auth synchronisation. Workday supports both job
// discovery and form fill, so it must use the normal job-page bootstrap.
const IS_DASHBOARD_PAGE =
  window.location.hostname === 'applymate.site'
const IS_KNOWN_JOB_PAGE = [
  /(^|\.)linkedin\.com$/i,
  /(^|\.)indeed\.[a-z.]+$/i,
  /(^|\.)glassdoor\.com$/i,
  /(^|\.)stepstone\.[a-z.]+$/i,
  /(^|\.)xing\.com$/i,
  /(^|\.)wellfound\.com$/i,
  /(^|\.)greenhouse\.io$/i,
  /(^|\.)lever\.co$/i,
  /(^|\.)workday\.com$/i,
  /(^|\.)myworkdayjobs\.com$/i,
  /(^|\.)smartrecruiters\.com$/i,
  /(^|\.)ashbyhq\.com$/i,
  /(^|\.)bamboohr\.com$/i,
  /(^|\.)jobvite\.com$/i,
  /(^|\.)icims\.com$/i,
  /(^|\.)monster\.[a-z.]+$/i,
  /(^|\.)arbeitsagentur\.de$/i,
  /(^|\.)jobs\.de$/i,
  /(^|\.)irishjobs\.ie$/i,
].some(pattern => pattern.test(window.location.hostname)) ||
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1' ||
  window.location.hostname === 'web-delta-ruddy-29.vercel.app'

// Generic company pages are injected on demand for form fill only. Keep the
// job-board bootstrap limited to known sources so optional all-site access
// never causes job scraping UI to appear on unrelated websites.
let SHOULD_BOOTSTRAP_JOB_UI =
  IS_KNOWN_JOB_PAGE && !IS_DASHBOARD_PAGE

const DEBUG = true
function log(...args: unknown[]) { if (DEBUG) console.log('[ApplyMate]', ...args) }

let currentJob: ScrapedJob | null = null
let injectAttempts = 0
let backgroundReady = false
let lastPanelSignature = ''
let lastSavedPanelSignature = ''
let panelRefreshTimer: ReturnType<typeof setTimeout> | null = null
const savedDetailJobKeys = new Set<string>()

function publishJob(job: ScrapedJob) {
  const stamped = { ...job, detectedAt: Date.now() }
  currentJob = stamped
  chrome.runtime.sendMessage({ type: 'JOB_SCRAPED', job: stamped }).catch(() => {})
}

function renderVisibleDetailSaved() {
  const btn = document.querySelector<HTMLButtonElement>(
    `#${BUTTON_ID} button, #am-lazy-btn`,
  )
  if (!btn) return
  btn.dataset.applymateSaved = 'true'
  btn.disabled = true
  delete btn.dataset.applymateBusy
  btn.innerHTML = '<span>✓ Saved to ApplyMate</span>'
  btn.title = 'Saved to ApplyMate'
  btn.style.setProperty('background', '#3B6D11', 'important')
  btn.style.setProperty('opacity', '1', 'important')
}

window.addEventListener('applymate:job-saved', (event) => {
  const key = (event as CustomEvent<{ key?: unknown }>).detail?.key
  if (!currentJob || typeof key !== 'string' || key !== getJobIdentity(currentJob)) return
  savedDetailJobKeys.add(key)
  lastSavedPanelSignature = getPanelSignature()
  renderVisibleDetailSaved()
})

type DetailReadResult = {
  job: ScrapedJob | null
  ready: boolean
}

const DETAIL_SCRAPE_DELAYS_MS = [0, 200, 350, 550, 800, 1_000]

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Job boards hydrate the header before the description. A save must sample
 * the live detail pane rather than the possibly stale `currentJob` snapshot.
 */
async function readReadyDetailJob(): Promise<DetailReadResult> {
  let best: ScrapedJob | null = null

  for (const delay of DETAIL_SCRAPE_DELAYS_MS) {
    if (delay > 0) await waitFor(delay)
    const candidate = detectAndScrape()
    if (!candidate) continue
    best = best ? mergeJobDetails(best, candidate) : candidate
    if (isJobReadyForTailoring(best)) return { job: best, ready: true }
  }

  return { job: best, ready: false }
}

function setIncompleteJobSaveState(btn: HTMLButtonElement, mode: 'inline' | 'floating') {
  btn.innerHTML = '<span>⚠ Details still loading</span>'
  btn.style.setProperty('background', '#854F0B', 'important')
  btn.style.setProperty('opacity', '1', 'important')
  btn.disabled = false
  delete btn.dataset.applymateBusy
  showToast('The job description is not ready yet. Wait for the detail panel to finish loading, then try Save again.')
  setTimeout(() => {
    if (btn.isConnected && btn.dataset.applymateBusy !== 'true') setSaveButtonIdle(btn, mode)
  }, 4_000)
}

function getVisibleDetailRoot(): HTMLElement | null {
  const host = window.location.hostname
  if (host.includes('linkedin.com')) {
    const legacyRoot = document.querySelector<HTMLElement>(
      '.jobs-search__job-details--container, .scaffold-layout__detail, .job-view-layout, .jobs-details__main-content'
    )
    // Current logged-in LinkedIn rolls out obfuscated detail-pane classes.
    // Its native Saved/Unsave action remains a reliable detail anchor, and
    // using its action row keeps SPA panel-refresh detection alive.
    return legacyRoot ?? findDetailActionHost(document)
  }
  if (/indeed\./i.test(host)) {
    const title = document.querySelector<HTMLElement>(
      '[data-testid="jobsearch-JobInfoHeader-title"], #vjs-jobtitle, [data-testid="jobTitle"]'
    )
    return title?.closest<HTMLElement>(
      '#jobsearch-ViewjobPaneWrapper, .jobsearch-ViewJobLayout--embedded, .jobsearch-JobComponent, #vjs-container, #vjs-details, #viewJobSSRRoot'
    ) ?? document.querySelector<HTMLElement>(
      '#jobsearch-ViewjobPaneWrapper, #vjs-container, #vjs-details, #viewJobSSRRoot, [data-testid="viewJobSSR"]'
    )
  }
  return null
}

function getPanelSignature(): string {
  const host = window.location.hostname
  const root = getVisibleDetailRoot()
  if (!root) return ''
  const selector = host.includes('linkedin.com')
    ? 'h1.job-details-jobs-unified-top-card__job-title, h1.t-24.t-bold, h1[class*="title"], [data-test-job-title], [data-job-name]'
    : '[data-testid="jobsearch-JobInfoHeader-title"], [data-testid="jobDetailHeader"] h1, #vjs-jobtitle, [data-testid="jobTitle"]'
  const title = root.querySelector<HTMLElement>(selector)?.innerText?.trim() ?? ''
  const idEl = root.querySelector<HTMLElement>('[data-job-id], [data-occludable-job-id], [data-jk]')
  const urlParams = new URLSearchParams(location.search)
  const urlId = host.includes('linkedin.com')
    ? (urlParams.get('currentJobId') || location.pathname.match(/\/jobs\/view\/(?:[^/?#]*-)?(\d{5,})(?:\/|$)/i)?.[1] || '')
    : (urlParams.get('vjk') || urlParams.get('jk') || '')
  const id = urlId || (
    idEl?.getAttribute('data-job-id') ??
    idEl?.getAttribute('data-occludable-job-id') ??
    idEl?.getAttribute('data-jk') ?? ''
  )
  return `${location.href}|${id}|${title}`
}

function refreshVisiblePanelJob() {
  if (!SHOULD_BOOTSTRAP_JOB_UI || !isJobListPage()) return
  const signature = getPanelSignature()
  const hasSaveButton = !!(
    document.getElementById(BUTTON_ID) || document.getElementById('am-lazy-btn')
  )
  if (!signature || signature === lastSavedPanelSignature) return
  if (signature === lastPanelSignature && hasSaveButton) return
  if (signature !== lastPanelSignature) lastSavedPanelSignature = ''
  lastPanelSignature = signature
  if (panelRefreshTimer) clearTimeout(panelRefreshTimer)
  panelRefreshTimer = setTimeout(() => {
    panelRefreshTimer = null
    if (getPanelSignature() !== signature) {
      refreshVisiblePanelJob()
      return
    }
    document.getElementById(BUTTON_ID)?.remove()
    document.getElementById('am-lazy-btn')?.remove()
    const job = detectAndScrape()
    if (job) {
      publishJob(job)
      injectDetailButtons()
      showDiagnosticBadge('panel-updated')
    } else {
      injectLazySaveButton()
    }
  }, 450)
}

// ── Visible diagnostic badge (appears bottom-right, shows init status) ───
let diagnosticLabel = ''

function showDiagnosticBadge(label: string) {
  diagnosticLabel = label
  const existing = document.getElementById('applymate-diag')
  if (existing) existing.remove()
  if (!document.body) return

  const badge = document.createElement('div')
  badge.id = 'applymate-diag'
  badge.textContent = 'AM:' + label
  Object.assign(badge.style, {
    position: 'fixed', bottom: '8px', right: '8px', zIndex: '2147483646',
    padding: '4px 10px', background: '#1a1a2e', color: '#fff',
    borderRadius: '6px', fontSize: '10px',
    fontFamily: 'monospace',
    boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
    opacity: '0.85',
    pointerEvents: 'none',
  })
  document.body.appendChild(badge)
  // Fade out after 8s
  setTimeout(() => {
    badge.style.transition = 'opacity 1s'
    badge.style.opacity = '0'
    setTimeout(() => badge.remove(), 1000)
  }, 8000)
}

function updateDiagnosticBadge() {
  const lazyBtn = document.getElementById('am-lazy-btn')
  const saveBtn = document.getElementById(BUTTON_ID)
  if (lazyBtn) {
    const rect = lazyBtn.getBoundingClientRect()
    showDiagnosticBadge('ok:' + diagnosticLabel + '|visible=' + (rect.width > 0 && rect.height > 0) + '|' + Math.round(rect.width) + 'x' + Math.round(rect.height))
  } else {
    showDiagnosticBadge('missing:' + diagnosticLabel)
  }
}

// ── Diagnostic: verify background connectivity (with retry) ──────────────────

async function checkBackground(): Promise<boolean> {
  for (let i = 0; i < 5; i++) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'PING' })
      log('Background OK — hasToken:', (res as any)?.settings?.hasToken, 'email:', (res as any)?.settings?.email)
      return true
    } catch {
      if (i < 4) await new Promise(r => setTimeout(r, 500))
    }
  }
  log('Background UNREACHABLE after 5 retries')
  return false
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function init() {
  try {
    log('🚀 init() START — host:', window.location.hostname, 'path:', window.location.pathname, 'search:', window.location.search)
    log('🚀 SHOULD_BOOTSTRAP_JOB_UI:', SHOULD_BOOTSTRAP_JOB_UI)

    // Ensure document.body exists (SPAs may defer it)
    if (!document.body) {
      log('⚠ document.body is null — waiting for DOM...')
      await new Promise<void>(resolve => {
        const obs = new MutationObserver(() => {
          if (document.body) { obs.disconnect(); resolve() }
        })
        obs.observe(document.documentElement, { childList: true, subtree: true })
        // Fallback: resolve after 5s anyway
        setTimeout(() => { obs.disconnect(); resolve() }, 5000)
      })
      log('document.body now:', !!document.body)
    }

    backgroundReady = await checkBackground()
    log('🚀 checkBackground result:', backgroundReady)
    if (!backgroundReady) {
      showToast('⚠ Extension background not ready. Try reloading the extension at chrome://extensions.')
    }

    const isList = isJobListPage()
    log('🚀 isJobListPage():', isList)

    if (isList) {
      log('Detected LIST page — starting card injector')
      startListModeInjector()
      // A board can change its card DOM without changing the URL. Keep a
      // reliable page-level fallback so the user can still save the visible
      // job even when no card selector matches the current experiment.
      setTimeout(() => {
        if (!document.querySelector('.applymate-card-btn') &&
            !document.getElementById('am-lazy-btn') &&
            !document.getElementById(BUTTON_ID)) {
          log('List cards not matched — injecting fallback save button')
          injectLazySaveButton()
        }
      }, 2500)
      // Immediately try panel detection, then retry on a timer
      // (LinkedIn/Indeed open job panels without URL changes)
      setTimeout(tryInjectPanelDetail, 1500)
      setTimeout(tryInjectPanelDetail, 3000)
      setTimeout(tryInjectPanelDetail, 6000)
      showDiagnosticBadge('list')
    } else {
      const host = window.location.hostname
      const isHighRisk =
        host.includes('linkedin.com') ||
        host.includes('indeed') ||
        host.includes('workday.com') ||
        host.includes('myworkdayjobs') ||
        host.includes('greenhouse.io') ||
        host.includes('lever.co') ||
        host.includes('ashbyhq.com') ||
        host.includes('smartrecruiters.com') ||
        host.includes('bamboohr.com') ||
        host.includes('jobvite.com') ||
        host.includes('icims.com')
        || host.includes('irishjobs.ie')

      log('🚀 isHighRisk:', isHighRisk, 'host:', host)

      if (isHighRisk) {
        log('Detected HIGH-RISK / SPA detail page — injecting lazy button (scrape on click)')
        injectLazySaveButton()
        showDiagnosticBadge('detail-lazy')
      } else {
        currentJob = detectAndScrape()
        if (currentJob) {
          log('Detected DETAIL page — job scraped:', currentJob.title, '@', currentJob.company)
          publishJob(currentJob)
          injectDetailButtons()
          showDiagnosticBadge('detail-scraped')
        } else {
          log('No job detected on this page')
          showDiagnosticBadge('no-job')
        }
      }
    }

    if (!isJobListPage()) {
      setTimeout(() => tryInjectAutoFillButton(), 2000)
    }

    log('🚀 init() DONE')

    // Self-diagnostic: check 3s later whether button actually made it
    setTimeout(() => {
      const lazyBtn = document.getElementById('am-lazy-btn')
      const saveBtn = document.getElementById(BUTTON_ID)
      if (!lazyBtn && !saveBtn) {
        const host = window.location.hostname
        const isHighRisk = host.includes('linkedin.com') || host.includes('indeed')
        if (isHighRisk) {
          console.error('[ApplyMate] ❌ DIAGNOSTIC: No save button 3s after init! Forcing injection...')
          // Try panel detection one more time, then fall back to lazy button
          tryInjectPanelDetail()
          setTimeout(() => {
            if (!document.getElementById('am-lazy-btn') && !document.getElementById(BUTTON_ID)) {
              injectLazySaveButton()
            }
          }, 2000)
        }
      }
      updateDiagnosticBadge()
    }, 3000)
  } catch (err) {
    console.error('[ApplyMate] ❌ init() CRASHED:', err)
    showDiagnosticBadge('crash: ' + String(err).slice(0, 40))
  }
}

// LinkedIn / Indeed SPA: inject the detail save button when a job detail panel
// is open within a search-results page. Uses DOM-based detection instead of
// relying on URL parameters (which change between LinkedIn/Indeed redesigns).
function tryInjectPanelDetail() {
  // Already have a save/lazy button — don't duplicate
  if (document.getElementById(BUTTON_ID) || document.getElementById('am-lazy-btn')) return

  // DOM-based panel detection: look for job title in a side panel or main content
  const host = window.location.hostname
  let hasPanel = false

  if (host.includes('linkedin.com')) {
    // LinkedIn detail panel signs (any of these means a job panel is visible):
    // - h1 with job title class anywhere on page
    // - Apply button visible (Easy Apply / external apply)
    // - Unified top card (standalone detail page or panel)
    hasPanel = !!(
      document.querySelector('h1.job-details-jobs-unified-top-card__job-title') ||
      document.querySelector('h1.t-24.t-bold, h1[class*="title"]') ||
      document.querySelector('.jobs-s-apply, .jobs-apply-button') ||
      document.querySelector('[data-job-name], [data-test-job-title]') ||
      document.querySelector('.job-details-jobs-unified-top-card__content')
    )
    // Also check URL: standalone detail or panel with currentJobId
    if (!hasPanel && (location.pathname.startsWith('/jobs/view/') || location.search.includes('currentJobId'))) {
      hasPanel = true
    }
  } else if (host.includes('indeed')) {
    hasPanel = !!(
      document.querySelector('[data-testid="jobDetailHeader"]') ||
      document.querySelector('#jobDescriptionText') ||
      document.querySelector('.jobsearch-JobInfoHeader, .jobsearch-DesktopStickyContainer') ||
      document.querySelector('#viewJobSSRRoot, [data-testid="viewJobSSR"]') ||
      location.pathname.startsWith('/viewjob') ||
      location.search.includes('jk=')
    )
    // Indeed's sidebar/panel in search results
    if (!hasPanel) {
      const sidebarTitle = document.querySelector('#vjs-details [data-testid="jobTitle"], #vjs-jobtitle')
      if (sidebarTitle) hasPanel = true
    }
  }

  if (!hasPanel) {
    log('🔎 Panel check: no job detail panel detected')
    return
  }

  log('🔎 Job detail panel detected — scraping for save button')
  const job = detectAndScrape()
  if (job) {
    currentJob = job
    publishJob(job)
    lastPanelSignature = getPanelSignature()
    injectDetailButtons()
    showDiagnosticBadge('panel-injected')
    log('Panel detail injected:', job.title, '@', job.company)
  } else {
    log('🔎 Panel detected but scraping returned null')
    // Lazy fallback: inject a click-to-scrape button
    injectLazySaveButton()
    showDiagnosticBadge('panel-lazy')
  }
}

// Retry for SPAs where content loads after navigation
function scheduleRetry() {
  injectAttempts = 0
  const host = window.location.hostname
  const isHighRisk =
    host.includes('linkedin.com') ||
    host.includes('indeed') ||
    host.includes('workday.com') ||
    host.includes('myworkdayjobs') ||
    host.includes('greenhouse.io') ||
    host.includes('lever.co') ||
    host.includes('ashbyhq.com') ||
    host.includes('smartrecruiters.com') ||
    host.includes('bamboohr.com') ||
    host.includes('jobvite.com') ||
    host.includes('icims.com')

  const interval = setInterval(() => {
    if (injectAttempts++ > 10) { clearInterval(interval); return }

    if (isJobListPage()) {
      clearInterval(interval)
      startListModeInjector()
      // LinkedIn/Indeed SPA: retry panel detection at staggered intervals
      // (panel DOM may take several seconds to render after user clicks a job)
      setTimeout(tryInjectPanelDetail, 1000)
      setTimeout(tryInjectPanelDetail, 3000)
      setTimeout(tryInjectPanelDetail, 6000)
      return
    }

    if (document.getElementById(BUTTON_ID) || document.getElementById('am-lazy-btn')) { clearInterval(interval); return }

    if (isHighRisk) {
      // LinkedIn/Indeed: use lazy button (scrape on click only)
      injectLazySaveButton()
      clearInterval(interval)
      return
    }

    currentJob = detectAndScrape()
    if (currentJob) {
      publishJob(currentJob)
      injectDetailButtons()
      clearInterval(interval)
    }
  }, 800)
}

// SPA navigation detection is needed for job boards only. In particular, do
// not observe Workday's frequently-changing application form after the side
// panel manually injects this script for a fill action.
if (SHOULD_BOOTSTRAP_JOB_UI) {
  // Guard: document.body may not exist yet in some SPA boot sequences.
  // Retry observation setup until body is available (max 10s).
  function setupMutationObserver() {
    if (!document.body) {
      setTimeout(setupMutationObserver, 200)
      return
    }
    let lastUrl = location.href
    contentRuntimeGlobal.__applyMateJobUiCleanup?.()
    const observer = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href
        document.getElementById(BUTTON_ID)?.remove()
        document.getElementById('am-lazy-btn')?.remove()
        document.getElementById(TOAST_ID)?.remove()
        currentJob = null
        backgroundReady = false
        checkBackground().then(ok => { backgroundReady = ok })
        scheduleRetry()
        // LinkedIn/Indeed SPA: try injecting detail button after any navigation
        setTimeout(tryInjectPanelDetail, 1500)
        setTimeout(tryInjectPanelDetail, 4000)
      }
      // LinkedIn/Indeed can replace only the detail panel while keeping the
      // same URL. Refresh only when the visible title/job id changes.
      refreshVisiblePanelJob()
    })
    observer.observe(document.body, { subtree: true, childList: true })
    contentRuntimeGlobal.__applyMateJobUiCleanup = () => observer.disconnect()
  }
  setupMutationObserver()
}

if (SHOULD_BOOTSTRAP_JOB_UI) {
  try {
    void init()
    setTimeout(scheduleRetry, 1500)
  } catch (err) {
    console.error('[ApplyMate] ❌ Bootstrap CRASHED:', err)
    showDiagnosticBadge('bootstrap-crash')
  }
}

// ── Form Filler: Listen for scan & fill commands ──────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'ENABLE_JOB_SCRAPING') {
    // Optional all-site access is granted by the Side Panel before this
    // command is sent. Unknown company pages start with form-fill only and
    // are promoted to the full job scraper only after that explicit grant.
    if (!SHOULD_BOOTSTRAP_JOB_UI) {
      SHOULD_BOOTSTRAP_JOB_UI = true
      void init()
      setTimeout(scheduleRetry, 1500)
    }
    sendResponse({ ok: true })
    return true
  }

  if (msg.type === 'GET_CURRENT_JOB') {
    sendResponse({ type: 'CURRENT_JOB_RESULT', job: currentJob })
    return true
  }

  if (msg.type === 'PING') {
    sendResponse({ type: 'PONG', hasJob: currentJob !== null })
    return true
  }

  if (msg.type === 'REFRESH_DASHBOARD_TOKEN') {
    if (!IS_DASHBOARD_PAGE) {
      sendResponse({ ok: false, error: 'Not an ApplyMate dashboard page' })
      return true
    }
    void syncFromDashboard(true)
      .then(ok => sendResponse({ ok }))
      .catch(() => sendResponse({ ok: false, error: 'Dashboard session refresh failed' }))
    return true
  }

  if (msg.type === 'APPLY_FIELD_VALUES') {
    log('APPLY_FIELD_VALUES received —', msg.fields?.length, 'fields to fill')
    try {
      const result = applyFieldValues(msg.fields, msg.schemas)
      log('Fill result:', result.failed.length === 0 ? 'all ok' : `${result.failed.length} failed`)
      if (result.failed.length > 0) {
        log('Failed field IDs:', result.failed.join(', '))
      }
      if (result.success) {
        removeAutoFillButton()
      }
      sendResponse({ type: 'APPLY_RESULT', ...result })
    } catch (e) {
      log('Fill error:', e)
      sendResponse({ type: 'APPLY_RESULT', success: false, failed: [String(e)], filled: 0 })
    }
    return true
  }

  if (msg.type === 'FORM_ANALYSIS_COMPLETE') {
    updateButtonState(msg.success ? 'done' : 'error')
    sendResponse({ ok: true })
    return true
  }

  if (msg.type === 'READ_FIELD_VALUES') {
    const values = readCurrentFieldValues(msg.fieldIds ?? [])
    sendResponse({ type: 'FIELD_VALUES_RESULT', values })
    return true
  }

  if (msg.type === 'OPEN_UPLOAD_PICKER') {
    const result = openUploadPicker(msg.fieldId, (fileName) => {
      chrome.runtime.sendMessage({ type: 'FILE_UPLOAD_CHANGED', fieldId: msg.fieldId, fileName }).catch(() => {})
    })
    sendResponse({ type: 'UPLOAD_PICKER_OPENED', success: result.success, error: result.error })
    return true
  }

  if (msg.type === 'SCAN_FORM') {
    const result = detectAndScanForms()
    if (result && result.fields.length > 0) {
      const types = result.fields.reduce((acc, f) => { acc[f.type] = (acc[f.type] ?? 0) + 1; return acc }, {} as Record<string, number>)
      log('Form scan:', result.fields.length, 'fields on', result.source, '|', JSON.stringify(types))
      // Also inject the floating button for convenience
      tryInjectAutoFillButton()
      sendResponse({
        type: 'FORM_DETECTED',
        fields: result.fields,
        source: result.source,
        formCount: result.formCount,
      })
    } else {
      log('Form scan: 0 fields found — page has', document.querySelectorAll('form').length, 'forms')
      sendResponse({ type: 'FORM_DETECTED', fields: [], source: 'none', formCount: 0 })
    }
    return true
  }
})

// ── Auth sync: Dashboard → Extension ──────────────────────────────────────

// Simplified: content script directly fetches the token from the same-origin API.
// No more MAIN-world injection / DOM attribute dance — just one fetch call.
function getSyncStorage(): chrome.storage.StorageArea | null {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.sync) return null
    return chrome.storage.sync
  } catch {
    // Content scripts can briefly outlive an extension reload, or be executed
    // in a page context without the extension storage API. Treat that as a
    // missing optional sync channel instead of throwing from a Promise.
    return null
  }
}

async function syncFromDashboard(force = false): Promise<boolean> {
  const meta = document.querySelector('meta[name="applymate:user"]') as HTMLMetaElement | null
  if (!meta?.content) return false

  const currentOrigin = window.location.origin // e.g. http://localhost:3000
  const syncStorage = getSyncStorage()
  if (!syncStorage) return false

  let result: { settings?: Partial<ExtensionSettings> }
  try {
    result = await syncStorage.get('settings') as typeof result
  } catch {
    return false
  }
  const s = result.settings ?? {}

  // Only skip if token exists AND email matches AND stored apiBaseUrl matches current origin
  // If apiBaseUrl changed (env switch), always re-fetch
  const alreadySynced = s.apiToken && s.userEmail === meta.content && s.apiBaseUrl === currentOrigin
  if (alreadySynced && !force) return true

  log('Dashboard user detected:', meta.content, '— fetching extension token for', currentOrigin)
  try {
    const res = await fetch('/api/auth/me/extension-token')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    await syncStorage.set({
      settings: {
        ...s,
        apiBaseUrl: currentOrigin,
        apiToken:   data.token,
        userEmail:  data.user?.email ?? '',
        userName:   data.user?.name  ?? '',
      }
    })
    log('Extension auto-logged in via dashboard:', data.user?.email, '@', currentOrigin)
    window.dispatchEvent(new CustomEvent('applymate:login'))
    return true
  } catch (err) {
    log('Failed to fetch extension token:', err)
    return false
  }
}

// Watch for meta tag appearing (user logs in after page load). This belongs
// exclusively to dashboard pages; observing arbitrary job sites was needless
// work on every DOM change.
if (IS_DASHBOARD_PAGE) {
  new MutationObserver(() => { void syncFromDashboard() }).observe(document.head, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['content'],
  })
}

// Dashboard logout clears extension auth. Login is intentionally one-way:
// an old extension token must never replace the active dashboard account.
window.addEventListener('message', (e) => {
  if (e.origin !== window.location.origin) return
  if (e.data?.type === 'DASHBOARD_LOGOUT') {
    log('Dashboard logged out — clearing extension auth')
    const syncStorage = getSyncStorage()
    if (!syncStorage) return
    void syncStorage.get('settings').then((result) => {
      const s = result.settings ?? {}
      if (s.apiToken) {
        return syncStorage.set({
          settings: { ...s, apiToken: '', userEmail: '', userName: '' }
        })
      }
      return undefined
    }).catch(() => undefined)
  }
})

// Run dashboard sync only on the dashboard; job pages never expose its user
// meta tag and do not need an additional storage read/fetch during startup.
if (IS_DASHBOARD_PAGE) {
  void syncFromDashboard(true)
  setTimeout(() => { void syncFromDashboard() }, 3000)
}

// ── Listen for login/logout changes from popup ──────────────────────────────

const syncStorageEvents = (() => {
  try {
    return typeof chrome !== 'undefined' ? chrome.storage?.onChanged ?? null : null
  } catch {
    return null
  }
})()

syncStorageEvents?.addListener((changes, area) => {
  if (area !== 'sync') return
  const settingsChange = changes.settings
  if (!settingsChange) return

  const oldToken = settingsChange.oldValue?.apiToken
  const newToken = settingsChange.newValue?.apiToken

  // User logged out
  if (oldToken && !newToken) {
    log('User logged out — resetting save buttons')
    savedDetailJobKeys.clear()
    const saveBtn = document.getElementById(BUTTON_ID)
    if (saveBtn) {
      const button = saveBtn.querySelector<HTMLButtonElement>('button')
      if (button) setSaveButtonIdle(button, 'inline')
    }
    const lazySaveBtn = document.getElementById('am-lazy-btn') as HTMLButtonElement | null
    if (lazySaveBtn) setSaveButtonIdle(lazySaveBtn, 'floating')
    window.dispatchEvent(new CustomEvent('applymate:logout'))
  }

  // The popup can change extension credentials, but the dashboard keeps its
  // own explicit session so a stale token cannot silently switch users.
  if (!oldToken && newToken) {
    log('Extension logged in as:', settingsChange.newValue?.userEmail)
    window.dispatchEvent(new CustomEvent('applymate:login'))
  }
})

// ── Detail mode: inline action near the job action controls ───────────────────

function applySaveButtonStyle(btn: HTMLButtonElement, mode: 'inline' | 'floating') {
  const s = btn.style
  // Use setProperty with 'important' so host-page CSS cannot override critical visibility
  s.setProperty('display', 'inline-flex', 'important')
  s.setProperty('align-items', 'center', 'important')
  s.setProperty('justify-content', 'center', 'important')
  s.setProperty('gap', '6px', 'important')
  if (mode === 'inline') s.setProperty('height', '40px', 'important')
  if (mode === 'inline') s.setProperty('padding', '0 16px', 'important')
  else s.setProperty('padding', '9px 14px 9px 12px', 'important')
  s.setProperty('background', '#4F46E5', 'important')
  s.setProperty('color', '#fff', 'important')
  s.setProperty('border', 'none', 'important')
  s.setProperty('border-radius', mode === 'inline' ? '999px' : '8px 0 0 8px', 'important')
  s.setProperty('font-size', '12px', 'important')
  s.setProperty('font-weight', '600', 'important')
  s.setProperty('cursor', 'pointer', 'important')
  s.setProperty('box-shadow', mode === 'inline' ? '0 2px 8px rgba(79,70,229,0.22)' : '-2px 2px 12px rgba(79,70,229,0.35)', 'important')
  s.setProperty('transition', 'all 0.15s', 'important')
  s.setProperty('white-space', 'nowrap', 'important')
  s.setProperty('font-family', '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', 'important')
  s.setProperty('line-height', '1', 'important')
  s.setProperty('opacity', '1', 'important')
  s.setProperty('visibility', 'visible', 'important')
  s.setProperty('pointer-events', 'auto', 'important')
}

function styleDetailContainer(el: HTMLElement, mode: 'inline' | 'floating') {
  const s = el.style
  if (mode === 'inline') {
    s.setProperty('display', 'inline-flex', 'important')
    s.setProperty('align-items', 'center', 'important')
    s.setProperty('margin-left', '8px', 'important')
    s.setProperty('vertical-align', 'middle', 'important')
    s.setProperty('font-family', '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', 'important')
  } else {
    s.setProperty('position', 'fixed', 'important')
    s.setProperty('top', '72px', 'important')
    s.setProperty('right', '0', 'important')
    s.setProperty('z-index', '2147483647', 'important')
    s.setProperty('display', 'flex', 'important')
    s.setProperty('font-family', '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', 'important')
    s.setProperty('visibility', 'visible', 'important')
    s.setProperty('pointer-events', 'auto', 'important')
  }
}

function setSaveButtonIdle(btn: HTMLButtonElement, mode: 'inline' | 'floating') {
  delete btn.dataset.applymateSaved
  btn.innerHTML = `<span style="font-size:14px;line-height:1">⊕</span><span>Save to ApplyMate</span>`
  btn.style.setProperty('background', '#4F46E5', 'important')
  btn.style.setProperty('opacity', '1', 'important')
  btn.style.setProperty('padding-right', mode === 'inline' ? '16px' : '14px', 'important')
  btn.disabled = false
  delete btn.dataset.applymateBusy
}

// Lazy save button for high-risk platforms (LinkedIn, Indeed):
// injects UI first, only scrapes on explicit user click — no automatic scraping.
function injectLazySaveButton() {
  log('🔵 injectLazySaveButton called — checking DOM for existing button...')
  if (document.getElementById('am-lazy-btn')) {
    log('🔵 Button already exists, skipping')
    return
  }

  log('🔵 Creating button element...')
  const btn = document.createElement('button')
  btn.id = 'am-lazy-btn'
  btn.type = 'button'
  btn.dataset.applymateRole = 'detail-save'
  btn.innerHTML = `<span style="font-size:14px;line-height:1">⊕</span><span>Save to ApplyMate</span>`
  log('🔵 Placing button via mountDetailButtonContainer...')
  const mode = mountDetailButtonContainer(btn)
  log('🔵 Button placement mode:', mode)
  styleDetailContainer(btn, mode)
  applySaveButtonStyle(btn, mode)
  log('🔵 Button styled, width:', btn.offsetWidth, 'height:', btn.offsetHeight, 'rect:', JSON.stringify(btn.getBoundingClientRect()))
  btn.addEventListener('mouseenter', () => {
    if (btn.dataset.applymateSaved === 'true') return
    btn.style.setProperty('background', '#4338CA', 'important')
    btn.style.setProperty('padding-right', '18px', 'important')
  })
  btn.addEventListener('mouseleave', () => {
    if (btn.dataset.applymateBusy === 'true' || btn.dataset.applymateSaved === 'true') return
    btn.style.setProperty('background', '#4F46E5', 'important')
    btn.style.setProperty('padding-right', mode === 'inline' ? '16px' : '14px', 'important')
  })
  if (currentJob && savedDetailJobKeys.has(getJobIdentity(currentJob))) {
    renderVisibleDetailSaved()
  }

  btn.addEventListener('click', async (e) => {
    if (!e.isTrusted) return
    e.preventDefault(); e.stopPropagation()
    if (btn.dataset.applymateBusy === 'true') return
    btn.dataset.applymateBusy = 'true'
    btn.disabled = true
    log('Lazy save button clicked — scraping on demand')
    btn.innerHTML = '<span>Scanning…</span>'
    btn.style.setProperty('opacity', '0.7', 'important')

    // Scrape on user click, then wait for the asynchronously hydrated job
    // description instead of persisting the earlier header-only snapshot.
    const detailRead = await readReadyDetailJob()
    if (!detailRead.job) {
      btn.innerHTML = '✗ No job found'
      btn.style.setProperty('background', '#A32D2D', 'important')
      setTimeout(() => setSaveButtonIdle(btn, mode), 3000)
      btn.style.setProperty('opacity', '1', 'important')
      return
    }
    if (!detailRead.ready) {
      setIncompleteJobSaveState(btn, mode)
      return
    }
    currentJob = detailRead.job

    log('Job scraped on demand:', currentJob.title, '@', currentJob.company)
    publishJob(currentJob)

    // Now save
    btn.innerHTML = '<span>Saving…</span>'
    try {
      const response = await chrome.runtime.sendMessage({ type: 'SAVE_JOB', job: currentJob })
      if (response?.success) {
        markJobSaved(currentJob)
        btn.innerHTML = '✓ Saved!'
        btn.style.setProperty('background', '#3B6D11', 'important')
        btn.style.setProperty('opacity', '1', 'important')
        showToast(`Saved: ${currentJob.title} @ ${currentJob.company}`)
        lastSavedPanelSignature = getPanelSignature()
        setTimeout(() => btn.remove(), 2500)
      } else {
        const msg = response?.error ?? 'Save failed'
        if (msg.includes('Not logged in') || msg.includes('login') || msg.includes('Unauthorized')) {
          btn.innerHTML = '⚡ Log in first'
          btn.style.setProperty('background', '#854F0B', 'important')
        } else {
          btn.innerHTML = '✗ Error'
          btn.style.setProperty('background', '#A32D2D', 'important')
        }
        btn.style.setProperty('opacity', '1', 'important')
        setTimeout(() => setSaveButtonIdle(btn, mode), 4000)
      }
    } catch (err: unknown) {
      btn.innerHTML = '💥 No connection'
      btn.style.setProperty('background', '#A32D2D', 'important')
      btn.style.setProperty('opacity', '1', 'important')
      setTimeout(() => setSaveButtonIdle(btn, mode), 4000)
    }
  })

  // Verify button is actually in DOM
  const inDOM = document.getElementById('am-lazy-btn')
  if (!inDOM) {
    console.error('[ApplyMate] ❌ Button NOT in DOM after injection! Forcing body append...')
    document.body.appendChild(btn)
    log('🔵 Force-appended to body, now in DOM:', !!document.getElementById('am-lazy-btn'))
  }

  log('🔵 Lazy save button injected (user-triggered scraping). Mode:', mode, '| Visible:',
    btn.offsetWidth > 0 && btn.offsetHeight > 0, '|', btn.offsetWidth, '×', btn.offsetHeight)
  updateDiagnosticBadge()
}

function injectDetailButtons() {
  if (document.getElementById(BUTTON_ID)) return
  if (!currentJob) return

  const wrap = document.createElement('div')
  wrap.id = BUTTON_ID // use same ID so duplicate-guard works

  // ── Save button ──
  const saveBtn = document.createElement('button')
  saveBtn.type = 'button'
  saveBtn.dataset.applymateRole = 'detail-save'
  saveBtn.innerHTML = `<span style="font-size:14px;line-height:1">⊕</span><span>Save to ApplyMate</span>`
  wrap.appendChild(saveBtn)
  const mode = mountDetailButtonContainer(wrap)
  styleDetailContainer(wrap, mode)
  applySaveButtonStyle(saveBtn, mode)
  if (savedDetailJobKeys.has(getJobIdentity(currentJob))) {
    renderDetailButtonSaved(saveBtn)
  }
  saveBtn.addEventListener('mouseenter', () => {
    if (saveBtn.dataset.applymateSaved === 'true') return
    saveBtn.style.setProperty('background', '#4338CA', 'important')
    saveBtn.style.setProperty('padding-right', '18px', 'important')
  })
  saveBtn.addEventListener('mouseleave', () => {
    if (saveBtn.dataset.applymateBusy === 'true' || saveBtn.dataset.applymateSaved === 'true') return
    saveBtn.style.setProperty('background', '#4F46E5', 'important')
    saveBtn.style.setProperty('padding-right', mode === 'inline' ? '16px' : '14px', 'important')
  })
  saveBtn.addEventListener('click', (e) => {
    if (!e.isTrusted) return
    e.preventDefault(); e.stopPropagation()
    if (saveBtn.dataset.applymateBusy === 'true') return
    log('Detail Save button clicked')
    saveDetailJob(saveBtn, mode)
  })

  log('Detail save button injected', mode)
}

function renderDetailButtonSaved(btn: HTMLButtonElement) {
  btn.dataset.applymateSaved = 'true'
  btn.disabled = true
  delete btn.dataset.applymateBusy
  btn.innerHTML = '<span>✓ Saved to ApplyMate</span>'
  btn.title = 'Saved to ApplyMate'
  btn.style.setProperty('background', '#3B6D11', 'important')
  btn.style.setProperty('opacity', '1', 'important')
}

async function saveDetailJob(btn: HTMLButtonElement, mode: 'inline' | 'floating') {
  const original = btn.innerHTML
  btn.dataset.applymateBusy = 'true'
  btn.disabled = true
  btn.innerHTML = '<span>Reading job details…</span>'
  btn.style.setProperty('opacity', '0.7', 'important')

  try {
    const detailRead = await readReadyDetailJob()
    if (!detailRead.job) {
      btn.innerHTML = '✗ No job found'
      btn.style.setProperty('background', '#A32D2D', 'important')
      btn.disabled = false
      delete btn.dataset.applymateBusy
      return
    }
    if (!detailRead.ready) {
      setIncompleteJobSaveState(btn, mode)
      return
    }
    currentJob = detailRead.job
    publishJob(currentJob)
    log('Saving fresh detail job:', currentJob.title)
    btn.innerHTML = '<span>Saving…</span>'
    const response = await chrome.runtime.sendMessage({ type: 'SAVE_JOB', job: currentJob })
    log('SAVE_JOB response:', response)

    if (response?.success) {
      markJobSaved(currentJob)
      renderDetailButtonSaved(btn)
      showToast(`Saved: ${currentJob.title} @ ${currentJob.company}`)
      lastSavedPanelSignature = getPanelSignature()
    } else {
      const msg = response?.error ?? 'Save failed'
      log('Save failed:', msg)
      if (msg.includes('Not logged in') || msg.includes('login') || msg.includes('logged') || msg.includes('Unauthorized')) {
        btn.innerHTML = '⚡ Log in first'
        btn.style.setProperty('background', '#854F0B', 'important')
        showToast('Not logged in — click the ApplyMate icon in the toolbar to log in.')
      } else if (msg.includes('fetch') || msg.includes('network') || msg.includes('Failed to fetch')) {
        btn.innerHTML = '🔌 API offline'
        btn.style.setProperty('background', '#A32D2D', 'important')
        showToast('Cannot reach ApplyMate server. Is the backend running?')
      } else {
        btn.innerHTML = '✗ Error'
        btn.style.setProperty('background', '#A32D2D', 'important')
        showToast('Error: ' + msg)
      }
      btn.disabled = false
      delete btn.dataset.applymateBusy
    }
  } catch (err: unknown) {
    log('SAVE_JOB threw:', err)
    const message = err instanceof Error ? err.message : String(err)
    btn.innerHTML = '💥 No connection'
    btn.style.setProperty('background', '#A32D2D', 'important')
    btn.disabled = false
    delete btn.dataset.applymateBusy
    showToast('Cannot reach extension. Try reloading at chrome://extensions/ (error: ' + message + ')')
  }
  btn.style.setProperty('opacity', '1', 'important')
  setTimeout(() => {
    // A successful save keeps the busy marker until the wrapper is removed.
    // Failed saves clear it above and become reusable after this short status.
    if (!btn.isConnected || btn.dataset.applymateBusy === 'true' || btn.dataset.applymateSaved === 'true') return
    btn.innerHTML = original
    btn.style.setProperty('background', '#4F46E5', 'important')
  }, 4000)
}

function showToast(message: string, duration = 4000) {
  document.getElementById(TOAST_ID)?.remove()
  const toast = document.createElement('div')
  toast.id = TOAST_ID
  toast.textContent = message
  Object.assign(toast.style, {
    position: 'fixed', bottom: '80px', right: '24px', zIndex: '2147483647',
    padding: '10px 14px', background: '#1a1a2e', color: '#fff',
    borderRadius: '8px', fontSize: '12px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)', opacity: '0',
    transition: 'opacity 0.3s', maxWidth: '380px', lineHeight: '1.5',
  })
  document.body.appendChild(toast)
  requestAnimationFrame(() => { toast.style.opacity = '1' })
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300) }, duration)
}

// ── Read current form field values (for persona refresh) ────────────────

const FIELD_S = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), ' +
  'textarea, select, [contenteditable="true"]'

function readCurrentFieldValues(fieldIds: string[]): Array<{ fieldId: string; value: string }> {
  const results: Array<{ fieldId: string; value: string }> = []
  const targetIds = new Map(fieldIds.map(fieldId => [fieldId.replace(/^frame\|\d+\|/, '').replace(/^iframe\|[^|]+\|/, ''), fieldId]))
  const docs: Document[] = [document]
  for (const iframe of Array.from(document.querySelectorAll('iframe'))) {
    try { const d = iframe.contentDocument; if (d) docs.push(d) } catch { /* x-origin */ }
  }
  for (const doc of docs) {
    for (const el of Array.from(doc.querySelectorAll(FIELD_S))) {
      const ht = el as HTMLElement
      const gid = generateId(ht)
      const originalId = targetIds.get(gid)
      if (originalId) {
        const tag = ht.tagName.toLowerCase()
        const type = (ht as HTMLInputElement).type ?? ''
        let val = ''
        if (tag === 'select') { const s = ht as HTMLSelectElement; val = s.options[s.selectedIndex]?.text ?? s.value }
        else if (type === 'checkbox') { val = (ht as HTMLInputElement).checked ? 'true' : 'false' }
        else if (type === 'radio') { val = (ht as HTMLInputElement).checked ? ((ht as HTMLInputElement).value || 'true') : '' }
        else if (ht.getAttribute('contenteditable') === 'true') { val = ht.textContent ?? '' }
        else { val = (ht as HTMLInputElement).value ?? '' }
        results.push({ fieldId: originalId, value: val })
      }
    }
  }
  return results
}

// ── Debug tool injected into MAIN world (accessible from devtools console) ──

function installDebugTool() {
  const script = document.createElement('script')
  script.textContent = `
    window.__amDebug = function () {
      var r = ['=== ApplyMate Page Debug ===', ''];
      r.push('📄 title: ' + JSON.stringify(document.title));
      r.push('🌐 URL: ' + location.href);
      r.push('');

      // Meta tags
      var ogT = document.querySelector('meta[property="og:title"]')?.content;
      var ogS = document.querySelector('meta[property="og:site_name"]')?.content;
      var metaD = document.querySelector('meta[name="description"]')?.content;
      r.push('🏷 Meta:');
      r.push('  og:title=' + JSON.stringify(ogT) + '  og:site_name=' + JSON.stringify(ogS));
      r.push('  description=' + JSON.stringify(metaD)?.slice(0, 100));
      r.push('');

      // All headings
      r.push('📋 Headings (h1-h3):');
      var hs = document.querySelectorAll('h1,h2,h3');
      for (var i = 0; i < Math.min(hs.length, 8); i++) {
        r.push('  ' + hs[i].tagName + ': ' + JSON.stringify(hs[i].textContent.trim().slice(0, 80)));
      }
      r.push('');

      // Job-related element counts
      r.push('🔍 Element counts:');
      var tests = [
        '[data-entity-urn]', '[data-job-id]', '[data-job-name]',
        'div.base-card', 'div.job-card-container',
        'li.jobs-search-results__list-item',
        'a[href*="/jobs/view/"]', 'a[href*="/company/"]',
        'img[alt*="logo" i]', 'img[alt*="company" i]',
        '[data-test-employer-name]',
        '.job-details-jobs-unified-top-card__company-name a',
        'h1[class*="title"]', '[class*="company-name"]',
        '#jobDescriptionText'
      ];
      for (var i = 0; i < tests.length; i++) {
        try {
          var n = document.querySelectorAll(tests[i]).length;
          r.push('  ' + tests[i].padEnd(55) + ' = ' + n);
        } catch(e) { r.push('  ' + tests[i].padEnd(55) + ' = ERROR'); }
      }
      r.push('');

      // JSON-LD
      var jsonld = document.querySelectorAll('script[type="application/ld+json"]');
      r.push('📋 JSON-LD: ' + jsonld.length + ' scripts');
      for (var i = 0; i < jsonld.length; i++) {
        try {
          var d = JSON.parse(jsonld[i].textContent);
          var types = [d['@type']].concat((d['@graph']||[]).map(function(g){return g['@type']})).filter(Boolean);
          r.push('  ['+i+'] @type: ' + types.join(', '));
        } catch(e) { r.push('  ['+i+'] parse error'); }
      }

      var out = r.join('\\n');
      console.log(out);
      return out;
    };
  `
  script.id = 'applymate-debug-tool'
  document.documentElement.appendChild(script)
  log('Debug tool installed: run __amDebug() in console')
}

contentRuntimeGlobal.__applyMateContentScriptState = 'ready'
