/**
 * ApplyMate AI — Background Service Worker
 * Handles: message routing, API calls, badge updates, side panel
 */
import { getSettings, setCurrentJob, setBadge, clearBadge } from '@/lib/storage'
import { login, saveJob, getRecentJobs, getStats, updateJob } from '@/lib/api'
import { getJobIdentity } from '@/lib/job-identity'
import type { ExtMessage, ExtensionSettings, SavedJob, ScrapedJob } from '@/lib/types'
import { isApplyMateDashboardUrl, isAuthFailure } from '@/lib/auth-recovery'

// ── Simple rate limiter (prevent excessive API calls) ──────────────
const RATE_LIMIT_WINDOW = 2000 // 2 seconds between same-type operations
const rateLimitMap = new Map<string, number>()
let latestJobDetectedAt = 0
const styledSaveUiTabs = new Set<number>()
const savedJobsByKey = new Map<string, SavedJob>()
const pendingSavesByKey = new Map<string, Promise<SavedJob>>()

function checkRateLimit(key: string): boolean {
  const now = Date.now()
  const last = rateLimitMap.get(key)
  if (last && now - last < RATE_LIMIT_WINDOW) return false
  rateLimitMap.set(key, now)
  return true
}

function isTrustedExtensionSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id
}

function isAllowedJobPageUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    // Content scripts support employer career pages beyond the curated source
    // list. The extension boundary already verifies the sender; here only
    // reject browser-internal pages and credential-bearing URLs.
    return !url.username && !url.password
  } catch { return false }
}

// Clean up rate limit map periodically to prevent memory leaks
setInterval(() => {
  const now = Date.now()
  for (const [key, time] of rateLimitMap.entries()) {
    if (now - time > 60000) rateLimitMap.delete(key)
  }
}, 60000)

// A service worker can survive an account switch. Saved-state memory belongs to
// the authenticated user, so never let it leak into the next account.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes.settings) return
  const before = changes.settings.oldValue as { apiToken?: unknown } | undefined
  const after = changes.settings.newValue as { apiToken?: unknown } | undefined
  if (before?.apiToken === after?.apiToken) return
  savedJobsByKey.clear()
  pendingSavesByKey.clear()
})

// ── URL → saved job ID cache (for auto-enrichment) ────────────────
async function cacheJobUrl(url: string, jobId: string) {
  const r = await chrome.storage.local.get('urlCache')
  const cache = (r.urlCache ?? {}) as Record<string, string>
  cache[url] = jobId
  // Keep only 200 most recent (simple FIFO via Object.keys order)
  const keys = Object.keys(cache)
  if (keys.length > 200) {
    const trimmed: Record<string, string> = {}
    keys.slice(-200).forEach(k => { trimmed[k] = cache[k] })
    await chrome.storage.local.set({ urlCache: trimmed })
  } else {
    await chrome.storage.local.set({ urlCache: cache })
  }
}

async function lookupCachedJobId(url: string): Promise<string | null> {
  const r = await chrome.storage.local.get('urlCache')
  const cache = (r.urlCache ?? {}) as Record<string, string>
  return cache[url] ?? null
}

// Chrome removes content scripts from already-open tabs when an unpacked
// extension is reloaded. Restore the Save UI only when the user activates a
// supported job board. The content bundle has its own duplicate-load guard,
// so this is safe after normal page navigation too.
function shouldRestoreSaveUi(url?: string): boolean {
  if (!url) return false
  try {
    const host = new URL(url).hostname
    if (host.includes('workday.com') || host.includes('myworkdayjobs.com')) return false
    return host.includes('linkedin.com') ||
      host.includes('indeed.') ||
      host.includes('glassdoor.com') ||
      host.includes('stepstone.') ||
      host.includes('xing.com') ||
      host.includes('wellfound.com') ||
      host.includes('greenhouse.io') ||
      host.includes('lever.co') ||
      host.includes('smartrecruiters.com') ||
      host.includes('ashbyhq.com') ||
      host.includes('bamboohr.com') ||
      host.includes('jobvite.com') ||
      host.includes('icims.com') ||
      host.includes('monster.') ||
      host.includes('arbeitsagentur.de') ||
      host.includes('jobs.de') ||
      host.includes('irishjobs.ie')
  } catch {
    return false
  }
}

async function refreshSettingsFromDashboard(): Promise<ExtensionSettings | null> {
  const tabs = await chrome.tabs.query({})
  const dashboardTabs = tabs.filter(tab => isApplyMateDashboardUrl(tab.url))
  for (const tab of dashboardTabs) {
    if (!tab.id) continue
    try {
      let response: { ok?: boolean } | undefined
      try {
        response = await chrome.tabs.sendMessage(tab.id, { type: 'REFRESH_DASHBOARD_TOKEN' }) as typeof response
      } catch {
        // Extension updates remove content scripts from already-open tabs.
        // Rehydrate the dashboard bridge before retrying the refresh request.
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'], world: 'ISOLATED' })
        response = await chrome.tabs.sendMessage(tab.id, { type: 'REFRESH_DASHBOARD_TOKEN' }) as typeof response
      }
      if (response?.ok) return getSettings()
    } catch {
      // The dashboard may be an older content-script instance. Try another
      // open dashboard tab before asking the user to sign in again.
    }
  }
  return null
}

async function saveJobWithAuthRecovery(settings: ExtensionSettings, job: ScrapedJob): Promise<SavedJob> {
  let activeSettings = settings
  if (!activeSettings.apiToken) {
    activeSettings = await refreshSettingsFromDashboard() ?? activeSettings
  }
  if (!activeSettings.apiToken) throw new Error('Not logged in — open the ApplyMate dashboard or extension popup to log in first')

  try {
    return await saveJob(activeSettings, job)
  } catch (error) {
    if (!isAuthFailure(error)) throw error
    const refreshed = await refreshSettingsFromDashboard()
    if (!refreshed?.apiToken) throw error
    return saveJob(refreshed, job)
  }
}

async function restoreSaveUi(tabId: number, url?: string): Promise<void> {
  if (!shouldRestoreSaveUi(url)) return
  try {
    // executeScript() does not apply the declarative content-script CSS. This
    // path is used after extension reloads, so inject the stylesheet first or
    // the list buttons exist in the DOM but are effectively unstyled/invisible.
    if (!styledSaveUiTabs.has(tabId)) {
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['assets/content/inject.css'],
      })
      styledSaveUiTabs.add(tabId)
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
      world: 'ISOLATED',
    })
  } catch {
    // The tab may be a restricted browser page or may have navigated away.
  }
}

async function restoreActiveSaveUi(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab?.id) await restoreSaveUi(tab.id, tab.url)
}

// ── Lifecycle ─────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    chrome.tabs.create({ url: 'http://localhost:3000' })
  }

  // Let Chrome show the side panel button in the toolbar
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })
  } catch { /* Chrome < 116 doesn't support setPanelBehavior */ }

  await restoreActiveSaveUi()
})

chrome.runtime.onStartup.addListener(() => { void restoreActiveSaveUi() })

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId)
    .then(tab => restoreSaveUi(tabId, tab.url))
    .catch(() => {})
})

chrome.tabs.onRemoved.addListener(tabId => {
  styledSaveUiTabs.delete(tabId)
})

// ── Keyboard shortcut Ctrl+Shift+U → open tracker ─────────

chrome.commands.onCommand.addListener((command) => {
  if (command === 'open_tracker') {
    openTrackerWindow().catch(console.error)
  }
})

// ── Message handler ───────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (msg: ExtMessage, sender, sendResponse) => {
    // Keep service worker alive during async handling (MV3 requirement)
    // Wrap in try-catch so a closed port doesn't throw
    handleMessage(msg, sender)
      .then(result => {
        try { sendResponse(result) } catch { /* port already closed */ }
      })
      .catch(err => {
        try { sendResponse({ error: String(err) }) } catch { /* port already closed */ }
      })
    return true  // keeps the message channel open for async response
  },
)

async function handleMessage(
  msg: ExtMessage,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  if (!isTrustedExtensionSender(sender)) return { error: 'Unauthorized sender' }
  if (msg.type === 'SAVE_JOB' && sender.tab && !isAllowedJobPageUrl(sender.tab.url)) {
    return { type: 'SAVE_JOB_RESULT', success: false, error: 'Saving is only available on supported job pages.' }
  }
  let settings = await getSettings()

  // The Dashboard owns the API endpoint and token. A job-site message (for
  // example Workday's PING) must never overwrite that authenticated setting:
  // doing so sent local users to production, where the platform model may not
  // be configured, and made form filling appear randomly unavailable.

  switch (msg.type) {
    case 'PING':
      return { type: 'PONG', settings: { hasToken: !!settings.apiToken, email: settings.userEmail, apiBaseUrl: settings.apiBaseUrl } }

    case 'GET_STATS': {
      if (!settings.apiToken) return { type: 'STATS_RESULT', stats: null }
      const stats = await getStats(settings)
      return { type: 'STATS_RESULT', stats }
    }

    case 'JOB_SCRAPED': {
      const detectedAt = msg.job.detectedAt ?? Date.now()
      if (detectedAt < latestJobDetectedAt) return { ok: true, stale: true }
      latestJobDetectedAt = detectedAt
      await setCurrentJob(msg.job)
      setBadge('1', '#4F46E5')

      // Auto-enrich: if we previously saved this job from a list page (no description),
      // patch it now that the user has visited the detail page.
      // Rate limited: max once per URL per 30s window.
      if (settings.apiToken && msg.job.description) {
        const jobId = await lookupCachedJobId(msg.job.url)
        if (jobId && checkRateLimit(`enrich:${msg.job.url}`)) {
          updateJob(settings, jobId, {
            description: msg.job.description,
            salary:      msg.job.salary ?? undefined,
            location:    msg.job.location,
          }).catch(err => console.warn('[ApplyMate] Auto-enrich failed:', err))
        }
      }
      return { ok: true }
    }

    case 'SAVE_JOB': {
      try {
        const key = getJobIdentity(msg.job)
        const cached = savedJobsByKey.get(key)
        if (cached) {
          return { type: 'SAVE_JOB_RESULT', success: true, alreadySaved: true, savedJob: cached }
        }

        let pending = pendingSavesByKey.get(key)
        if (!pending) {
          pending = saveJobWithAuthRecovery(settings, msg.job)
          pendingSavesByKey.set(key, pending)
        }
        const savedJob = await pending
        savedJobsByKey.set(key, savedJob)
        pendingSavesByKey.delete(key)
        // Cache URL→jobId for later auto-enrichment when user visits the detail page
        if (savedJob?.id && msg.job.url) {
          await cacheJobUrl(msg.job.url, savedJob.id)
        }
        setBadge('✓', '#3B6D11')
        setTimeout(clearBadge, 3000)
        return { type: 'SAVE_JOB_RESULT', success: true, savedJob }
      } catch (err) {
        pendingSavesByKey.delete(getJobIdentity(msg.job))
        const error = err instanceof Error ? err.message : String(err)
        return { type: 'SAVE_JOB_RESULT', success: false, error }
      }
    }

    case 'GET_RECENT_JOBS': {
      if (!settings.apiToken) return { type: 'RECENT_JOBS_RESULT', jobs: [] }
      const jobs = await getRecentJobs(settings)
      return { type: 'RECENT_JOBS_RESULT', jobs }
    }

    case 'OPEN_SIDE_PANEL': {
      return openTrackerWindow()
    }

    // ── Form Filler ──
    case 'FORM_DETECTED':
      // Sidepanel handles this directly — background just acknowledges
      return { ok: true }

    case 'FORM_ANALYSIS_COMPLETE': {
      // Forward to content script to update the floating button state
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
        if (tab?.id) {
          chrome.tabs.sendMessage(tab.id, msg).catch(() => {})
        }
      } catch { /* ignore */ }
      return { ok: true }
    }

    case 'SCAN_FORM': {
      // Forward to content script to re-scan form (sidepanel → background → content)
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
        if (tab?.id) {
          chrome.tabs.sendMessage(tab.id, { type: 'SCAN_FORM' }).catch(() => {})
        }
      } catch { /* ignore */ }
      return { ok: true }
    }

    case 'FILE_UPLOAD_CHANGED':
      return { ok: true }

    default:
      return { error: 'Unknown message type' }
  }
}

// ── Shared: open tracker side panel ──────────────────────

async function openTrackerWindow(): Promise<{ ok: boolean; error?: string }> {
  const url = chrome.runtime.getURL('sidepanel.html')

  // Method 1: Chrome native sidePanel (best UX, slides out from right)
  try {
    const win = await chrome.windows.getLastFocused()
    if (win.id) {
      await chrome.sidePanel.open({ windowId: win.id })
      console.log('[ApplyMate] Side panel opened natively')
      return { ok: true }
    }
  } catch { /* fall through */ }

  // Method 2: Open in a new tab (always works, most reliable)
  try {
    await chrome.tabs.create({ url, active: true })
    console.log('[ApplyMate] Tracker opened in new tab')
    return { ok: true }
  } catch { /* fall through */ }

  // Method 3: Popup window fallback (last resort)
  try {
    const win = await chrome.windows.getLastFocused()
    const left = win.left != null && win.width != null ? win.left + win.width - 430 : 1000
    await chrome.windows.create({
      url, type: 'popup', width: 430,
      height: win.height ?? 900, left, top: win.top ?? 0,
      focused: true,
    })
    console.log('[ApplyMate] Tracker opened as popup')
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[ApplyMate] All open methods failed:', message)
    return { ok: false, error: message }
  }
}

// ── Tab navigation ────────────────────────────────────────────

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status === 'loading') styledSaveUiTabs.delete(tabId)
  if (info.status !== 'complete') return
  if (!tab.url) return

  void restoreSaveUi(tabId, tab.url)

  const JOB_PATTERNS = [
    /linkedin\.com\/jobs/,
    /indeed\.[^/]+\/(viewjob|jobs)/,
    /indeed\.[^/]+\/\?q=/,
    /glassdoor\.com\/(Job|job-listing|Jobs)/,
    /stepstone\.(de|at|ch|be|nl|fr)\//,
    /xing\.com\/jobs\//,
    /wellfound\.com\//,
    /greenhouse\.io\//,       // was /jobs// — misses boards.greenhouse.io/company/jobs/
    /lever\.co\//,
    /myworkdayjobs\.com\//,
    /workday\.com\//,
    /smartrecruiters\.com\//,
    /ashbyhq\.com\//,
    /bamboohr\.com\/jobs\//,
    /jobvite\.com\/jobs\//,
    /icims\.com\//,
    /monster\.(com|de|co\.uk)\//,
    /arbeitsagentur\.de\/jobsuche\//,
    /jobs\.de\//,
    /irishjobs\.ie\//,
  ]
  const isJobPage = JOB_PATTERNS.some(p => p.test(tab.url!))

  if (!isJobPage) {
    clearBadge()
    await setCurrentJob(null)
  }
})
