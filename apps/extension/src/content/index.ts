/**
 * ApplyMate AI — Content Script
 * Two modes:
 *  • List page  → per-card ⊕ button + hover popup
 *  • Detail page → inline Save to ApplyMate near the job action buttons
 */
import { detectAndScrape } from '@/lib/scrapers/detect'
import { startListModeInjector, isJobListPage } from './list-injector'
import { tryInjectAutoFillButton, removeAutoFillButton, applyFieldValues, updateButtonState } from './form-injector'
import { mountDetailButtonContainer } from './detail-button-placement'
import { detectAndScanForms } from '../lib/form-filler/detectors/detect'
import { generateId } from '../lib/form-filler/form-scanner'
import { openUploadPicker } from '../lib/form-filler/auto-fill'
import type { ScrapedJob } from '@/lib/types'

const BUTTON_ID   = 'applymate-save-btn'
const TOAST_ID    = 'applymate-toast'

// The dashboard only needs auth synchronisation, and Workday is injected on
// demand for form fill. Running the job-board bootstrap on either page starts
// repeated DOM scans and retry timers that provide no value there.
const IS_DASHBOARD_PAGE =
  window.location.hostname === 'localhost' ||
  window.location.hostname === 'web-delta-ruddy-29.vercel.app' ||
  window.location.hostname.endsWith('.applymate.ai')
const IS_FORM_FILL_ONLY_PAGE =
  window.location.hostname.includes('workday.com') ||
  window.location.hostname.includes('myworkdayjobs.com')
const SHOULD_BOOTSTRAP_JOB_UI = !IS_DASHBOARD_PAGE && !IS_FORM_FILL_ONLY_PAGE

const DEBUG = true
function log(...args: unknown[]) { if (DEBUG) console.log('[ApplyMate]', ...args) }

let currentJob: ScrapedJob | null = null
let injectAttempts = 0
let backgroundReady = false

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
  backgroundReady = await checkBackground()
  if (!backgroundReady) {
    showToast('⚠ Extension background not ready. Try reloading the extension at chrome://extensions.')
  }

  if (isJobListPage()) {
    log('Detected LIST page — starting card injector')
    startListModeInjector()
    // LinkedIn SPA: search results can show a detail panel at the same time.
    // Schedule a deferred attempt to inject the detail button for the visible panel.
    setTimeout(tryInjectPanelDetail, 1500)
  } else {
    // Safety: for LinkedIn and Indeed detail pages, only scrape on user click.
    // This significantly reduces detectable scraping patterns on these platforms.
    const host = window.location.hostname
    // High-risk: LinkedIn/Indeed (detection risk) + SPA platforms where content loads async
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

    if (isHighRisk) {
      log('Detected HIGH-RISK / SPA detail page — injecting lazy button (scrape on click)')
      injectLazySaveButton()
    } else {
      currentJob = detectAndScrape()
      if (currentJob) {
        log('Detected DETAIL page — job scraped:', currentJob.title, '@', currentJob.company)
        chrome.runtime.sendMessage({ type: 'JOB_SCRAPED', job: currentJob }).catch(() => {})
        chrome.storage.local.set({ currentJob }).catch(() => {})
        injectDetailButtons()
      } else {
        log('No job detected on this page')
      }
    }
  }

  // After job detection on detail pages, also try to inject auto-fill button
  if (!isJobListPage()) {
    setTimeout(() => tryInjectAutoFillButton(), 2000)
  }
}

// LinkedIn SPA: inject the detail save button when a job panel is open
// within a search-results page (URL contains currentJobId).
function tryInjectPanelDetail() {
  if (!location.search.includes('currentJobId')) return
  if (document.getElementById(BUTTON_ID)) return   // already injected
  const job = detectAndScrape()
  if (job) {
    currentJob = job
    chrome.runtime.sendMessage({ type: 'JOB_SCRAPED', job }).catch(() => {})
    chrome.storage.local.set({ currentJob: job }).catch(() => {})
    injectDetailButtons()
    log('Panel detail injected:', job.title, '@', job.company)
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
      // LinkedIn SPA: also try to inject detail button for visible panel
      setTimeout(tryInjectPanelDetail, 1000)
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
      chrome.runtime.sendMessage({ type: 'JOB_SCRAPED', job: currentJob }).catch(() => {})
      chrome.storage.local.set({ currentJob }).catch(() => {})
      injectDetailButtons()
      clearInterval(interval)
    }
  }, 800)
}

// SPA navigation detection is needed for job boards only. In particular, do
// not observe Workday's frequently-changing application form after the side
// panel manually injects this script for a fill action.
if (SHOULD_BOOTSTRAP_JOB_UI) {
  let lastUrl = location.href
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href
      document.getElementById(BUTTON_ID)?.remove()   // removes the wrap div (BUTTON_ID is on the wrap)
      document.getElementById('am-lazy-btn')?.remove()
      document.getElementById(TOAST_ID)?.remove()
      currentJob = null
      backgroundReady = false
      checkBackground().then(ok => { backgroundReady = ok })
      scheduleRetry()
      // LinkedIn SPA: currentJobId in URL means a new job panel just opened.
      // Give the panel 1.5s to render before trying to inject the detail button.
      if (location.search.includes('currentJobId')) {
        setTimeout(tryInjectPanelDetail, 1500)
      }
    }
  }).observe(document.body, { subtree: true, childList: true })
}

if (SHOULD_BOOTSTRAP_JOB_UI) {
  void init()
  setTimeout(scheduleRetry, 1500)
}

// ── Form Filler: Listen for scan & fill commands ──────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
async function syncFromDashboard() {
  const meta = document.querySelector('meta[name="applymate:user"]') as HTMLMetaElement | null
  if (!meta?.content) return

  const currentOrigin = window.location.origin // e.g. http://localhost:3000
  const result = await chrome.storage.sync.get('settings')
  const s = result.settings ?? {}

  // Only skip if token exists AND email matches AND stored apiBaseUrl matches current origin
  // If apiBaseUrl changed (env switch), always re-fetch
  const alreadySynced = s.apiToken && s.userEmail === meta.content && s.apiBaseUrl === currentOrigin
  if (alreadySynced) return

  log('Dashboard user detected:', meta.content, '— fetching extension token for', currentOrigin)
  try {
    const res = await fetch('/api/auth/me/extension-token')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    await chrome.storage.sync.set({
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
  } catch (err) {
    log('Failed to fetch extension token:', err)
  }
}

// Watch for meta tag appearing (user logs in after page load). This belongs
// exclusively to dashboard pages; observing arbitrary job sites was needless
// work on every DOM change.
if (IS_DASHBOARD_PAGE) {
  new MutationObserver(() => { void syncFromDashboard() }).observe(document.head, {
    childList: true, subtree: true,
  })
}

// Direction 2: Extension ↔ Dashboard (bidirectional via postMessage)

function pushToDashboard(token: string, email: string) {
  window.postMessage({ type: 'APPLYMATE_TOKEN', token, email }, window.location.origin)
  log('Pushed extension token to dashboard')
}

function pushLogoutToDashboard() {
  window.postMessage({ type: 'APPLYMATE_LOGOUT' }, window.location.origin)
  log('Pushed extension logout to dashboard')
}

// Listen for dashboard logout → clear extension auth
window.addEventListener('message', (e) => {
  if (e.origin !== window.location.origin) return
  if (e.data?.type === 'DASHBOARD_LOGOUT') {
    log('Dashboard logged out — clearing extension auth')
    chrome.storage.sync.get('settings', (result) => {
      const s = result.settings ?? {}
      if (s.apiToken) {
        chrome.storage.sync.set({
          settings: { ...s, apiToken: '', userEmail: '', userName: '' }
        })
      }
    })
  }
})

// Run dashboard sync only on the dashboard; job pages never expose its user
// meta tag and do not need an additional storage read/fetch during startup.
if (IS_DASHBOARD_PAGE) {
  void syncFromDashboard()
  setTimeout(() => { void syncFromDashboard() }, 3000)
}

// ── Listen for login/logout changes from popup ──────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return
  const settingsChange = changes.settings
  if (!settingsChange) return

  const oldToken = settingsChange.oldValue?.apiToken
  const newToken = settingsChange.newValue?.apiToken

  // User logged out
  if (oldToken && !newToken) {
    log('User logged out — resetting save buttons')
    const saveBtn = document.getElementById(BUTTON_ID)
    if (saveBtn) {
      saveBtn.innerHTML = `<span style="font-size:13px">⊕</span><span>Save to ApplyMate</span>`
      ;(saveBtn as HTMLButtonElement).style.background = '#4F46E5'
      ;(saveBtn as HTMLButtonElement).style.opacity = '1'
    }
    pushLogoutToDashboard()
    window.dispatchEvent(new CustomEvent('applymate:logout'))
  }

  // User logged in via extension popup → push to dashboard
  if (!oldToken && newToken) {
    log('Extension logged in as:', settingsChange.newValue?.userEmail)
    pushToDashboard(newToken, settingsChange.newValue?.userEmail ?? '')
    window.dispatchEvent(new CustomEvent('applymate:login'))
  }
})

// ── Detail mode: inline action near the job action controls ───────────────────

function applySaveButtonStyle(btn: HTMLButtonElement, mode: 'inline' | 'floating') {
  Object.assign(btn.style, {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    height: mode === 'inline' ? '40px' : undefined,
    padding: mode === 'inline' ? '0 16px' : '9px 14px 9px 12px',
    background: '#4F46E5',
    color: '#fff',
    border: 'none',
    borderRadius: mode === 'inline' ? '999px' : '8px 0 0 8px',
    fontSize: '12px',
    fontWeight: '600',
    cursor: 'pointer',
    boxShadow: mode === 'inline' ? '0 2px 8px rgba(79,70,229,0.22)' : '-2px 2px 12px rgba(79,70,229,0.35)',
    transition: 'all 0.15s',
    whiteSpace: 'nowrap',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    lineHeight: '1',
  })
}

function styleDetailContainer(el: HTMLElement, mode: 'inline' | 'floating') {
  Object.assign(el.style, mode === 'inline'
    ? {
        display: 'inline-flex',
        alignItems: 'center',
        marginLeft: '8px',
        verticalAlign: 'middle',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }
    : {
        position: 'fixed',
        top: '72px',
        right: '0px',
        zIndex: '2147483647',
        display: 'flex',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      })
}

function setSaveButtonIdle(btn: HTMLButtonElement, mode: 'inline' | 'floating') {
  btn.innerHTML = `<span style="font-size:14px;line-height:1">⊕</span><span>Save to ApplyMate</span>`
  btn.style.background = '#4F46E5'
  btn.style.opacity = '1'
  btn.style.paddingRight = mode === 'inline' ? '16px' : '14px'
}

// Lazy save button for high-risk platforms (LinkedIn, Indeed):
// injects UI first, only scrapes on explicit user click — no automatic scraping.
function injectLazySaveButton() {
  if (document.getElementById('am-lazy-btn')) return

  const btn = document.createElement('button')
  btn.id = 'am-lazy-btn'
  btn.innerHTML = `<span style="font-size:14px;line-height:1">⊕</span><span>Save to ApplyMate</span>`
  const mode = mountDetailButtonContainer(btn)
  styleDetailContainer(btn, mode)
  applySaveButtonStyle(btn, mode)
  btn.addEventListener('mouseenter', () => { btn.style.background = '#4338CA'; btn.style.paddingRight = mode === 'inline' ? '18px' : '18px' })
  btn.addEventListener('mouseleave', () => { btn.style.background = '#4F46E5'; btn.style.paddingRight = mode === 'inline' ? '16px' : '14px' })

  btn.addEventListener('click', async (e) => {
    e.preventDefault(); e.stopPropagation()
    log('Lazy save button clicked — scraping on demand')
    btn.innerHTML = '<span>Scanning…</span>'
    btn.style.opacity = '0.7'

    // Scrape ONLY on user click — no pre-load scraping
    currentJob = detectAndScrape()
    if (!currentJob) {
      btn.innerHTML = '✗ No job found'
      btn.style.background = '#A32D2D'
      setTimeout(() => setSaveButtonIdle(btn, mode), 3000)
      btn.style.opacity = '1'
      return
    }

    log('Job scraped on demand:', currentJob.title, '@', currentJob.company)
    chrome.runtime.sendMessage({ type: 'JOB_SCRAPED', job: currentJob }).catch(() => {})
    chrome.storage.local.set({ currentJob }).catch(() => {})

    // Now save
    btn.innerHTML = '<span>Saving…</span>'
    try {
      const response = await chrome.runtime.sendMessage({ type: 'SAVE_JOB', job: currentJob })
      if (response?.success) {
        btn.innerHTML = '✓ Saved!'
        btn.style.background = '#3B6D11'
        btn.style.opacity = '1'
        showToast(`Saved: ${currentJob.title} @ ${currentJob.company}`)
        setTimeout(() => btn.remove(), 2500)
      } else {
        const msg = response?.error ?? 'Save failed'
        if (msg.includes('Not logged in') || msg.includes('login') || msg.includes('Unauthorized')) {
          btn.innerHTML = '⚡ Log in first'
          btn.style.background = '#854F0B'
        } else {
          btn.innerHTML = '✗ Error'
          btn.style.background = '#A32D2D'
        }
        btn.style.opacity = '1'
        setTimeout(() => setSaveButtonIdle(btn, mode), 4000)
      }
    } catch (err: unknown) {
      btn.innerHTML = '💥 No connection'
      btn.style.background = '#A32D2D'
      btn.style.opacity = '1'
      setTimeout(() => setSaveButtonIdle(btn, mode), 4000)
    }
  })

  log('Lazy save button injected (user-triggered scraping)', mode)
}

function injectDetailButtons() {
  if (document.getElementById(BUTTON_ID)) return
  if (!currentJob) return

  const wrap = document.createElement('div')
  wrap.id = BUTTON_ID // use same ID so duplicate-guard works

  // ── Save button ──
  const saveBtn = document.createElement('button')
  saveBtn.innerHTML = `<span style="font-size:14px;line-height:1">⊕</span><span>Save to ApplyMate</span>`
  wrap.appendChild(saveBtn)
  const mode = mountDetailButtonContainer(wrap)
  styleDetailContainer(wrap, mode)
  applySaveButtonStyle(saveBtn, mode)
  saveBtn.addEventListener('mouseenter', () => {
    saveBtn.style.background = '#4338CA'
    saveBtn.style.paddingRight = mode === 'inline' ? '18px' : '18px'
  })
  saveBtn.addEventListener('mouseleave', () => {
    saveBtn.style.background = '#4F46E5'
    saveBtn.style.paddingRight = mode === 'inline' ? '16px' : '14px'
  })
  saveBtn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation()
    log('Detail Save button clicked')
    saveDetailJob(saveBtn, wrap)
  })

  log('Detail save button injected', mode)
}

async function saveDetailJob(btn: HTMLButtonElement, wrap: HTMLElement) {
  if (!currentJob) return
  log('Saving detail job:', currentJob.title)

  const original = btn.innerHTML
  btn.innerHTML = '<span>Saving…</span>'
  btn.style.opacity = '0.7'

  try {
    const response = await chrome.runtime.sendMessage({ type: 'SAVE_JOB', job: currentJob })
    log('SAVE_JOB response:', response)

    if (response?.success) {
      btn.innerHTML = '✓ Saved!'
      btn.style.background = '#3B6D11'
      btn.style.opacity    = '1'
      showToast(`Saved: ${currentJob.title} @ ${currentJob.company}`)
      setTimeout(() => wrap.remove(), 2500)
    } else {
      const msg = response?.error ?? 'Save failed'
      log('Save failed:', msg)
      if (msg.includes('Not logged in') || msg.includes('login') || msg.includes('logged') || msg.includes('Unauthorized')) {
        btn.innerHTML = '⚡ Log in first'
        btn.style.background = '#854F0B'
        showToast('Not logged in — click the ApplyMate icon in the toolbar to log in.')
      } else if (msg.includes('fetch') || msg.includes('network') || msg.includes('Failed to fetch')) {
        btn.innerHTML = '🔌 API offline'
        btn.style.background = '#A32D2D'
        showToast('Cannot reach ApplyMate server. Is the backend running?')
      } else {
        btn.innerHTML = '✗ Error'
        btn.style.background = '#A32D2D'
        showToast('Error: ' + msg)
      }
    }
  } catch (err: unknown) {
    log('SAVE_JOB threw:', err)
    const message = err instanceof Error ? err.message : String(err)
    btn.innerHTML = '💥 No connection'
    btn.style.background = '#A32D2D'
    showToast('Cannot reach extension. Try reloading at chrome://extensions/ (error: ' + message + ')')
  }
  btn.style.opacity = '1'
  setTimeout(() => { btn.innerHTML = original; btn.style.background = '#4F46E5' }, 4000)
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
  const targets = new Set(fieldIds)
  const docs: Document[] = [document]
  for (const iframe of Array.from(document.querySelectorAll('iframe'))) {
    try { const d = iframe.contentDocument; if (d) docs.push(d) } catch { /* x-origin */ }
  }
  for (const doc of docs) {
    for (const el of Array.from(doc.querySelectorAll(FIELD_S))) {
      const ht = el as HTMLElement
      const gid = generateId(ht)
      if (targets.has(gid)) {
        const tag = ht.tagName.toLowerCase()
        const type = (ht as HTMLInputElement).type ?? ''
        let val = ''
        if (tag === 'select') { const s = ht as HTMLSelectElement; val = s.options[s.selectedIndex]?.text ?? s.value }
        else if (type === 'checkbox') { val = (ht as HTMLInputElement).checked ? 'true' : 'false' }
        else if (type === 'radio') { val = (ht as HTMLInputElement).checked ? ((ht as HTMLInputElement).value || 'true') : '' }
        else if (ht.getAttribute('contenteditable') === 'true') { val = ht.textContent ?? '' }
        else { val = (ht as HTMLInputElement).value ?? '' }
        results.push({ fieldId: gid, value: val })
      }
    }
  }
  return results
}
