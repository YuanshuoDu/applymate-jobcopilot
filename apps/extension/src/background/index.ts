/**
 * ApplyMate AI — Background Service Worker
 * Handles: message routing, API calls, badge updates, side panel
 */
import { clearAccountLocalState, getAccountStorageKey, getSettings, setCurrentJob, setBadge, clearBadge } from '@/lib/storage'
import { login, saveJob, getRecentJobs, getStats, updateJob, scoreSavedJob } from '@/lib/api'
import { getJobIdentity } from '@/lib/job-identity'
import type { DashboardStats, ExtMessage, ExtensionSettings, SavedJob, ScrapedJob } from '@/lib/types'
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
  const before = changes.settings.oldValue as { apiToken?: unknown; userEmail?: unknown; apiBaseUrl?: unknown } | undefined
  const after = changes.settings.newValue as { apiToken?: unknown; userEmail?: unknown; apiBaseUrl?: unknown } | undefined
  if (before?.apiToken === after?.apiToken && before?.userEmail === after?.userEmail && before?.apiBaseUrl === after?.apiBaseUrl) return
  savedJobsByKey.clear()
  pendingSavesByKey.clear()
  if (before?.userEmail && before.userEmail !== after?.userEmail) {
    void clearAccountLocalState(String(before.userEmail))
  }
})

// ── URL → saved job ID cache (for auto-enrichment) ────────────────
async function cacheJobUrl(url: string, jobId: string, userEmail?: string) {
  const key = getAccountStorageKey('urlCache', userEmail)
  const r = await chrome.storage.local.get(key)
  const cache = (r[key] ?? {}) as Record<string, string>
  cache[url] = jobId
  // Keep only 200 most recent (simple FIFO via Object.keys order)
  const keys = Object.keys(cache)
  if (keys.length > 200) {
    const trimmed: Record<string, string> = {}
    keys.slice(-200).forEach(k => { trimmed[k] = cache[k] })
    await chrome.storage.local.set({ [key]: trimmed })
  } else {
    await chrome.storage.local.set({ [key]: cache })
  }
}

async function lookupCachedJobId(url: string, userEmail?: string): Promise<string | null> {
  const key = getAccountStorageKey('urlCache', userEmail)
  const r = await chrome.storage.local.get(key)
  const cache = (r[key] ?? {}) as Record<string, string>
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
    return host.includes('linkedin.com') ||
      host.includes('indeed.') ||
      host.includes('glassdoor.com') ||
      host.includes('stepstone.') ||
      host.includes('xing.com') ||
      host.includes('wellfound.com') ||
      host.includes('greenhouse.io') ||
      host.includes('lever.co') ||
      host.includes('workday.com') ||
      host.includes('myworkdayjobs.com') ||
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

async function refreshBackgroundSettingsFromDashboard(): Promise<ExtensionSettings | null> {
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
    activeSettings = await refreshBackgroundSettingsFromDashboard() ?? activeSettings
  }
  if (!activeSettings.apiToken) throw new Error('Not logged in — open the ApplyMate dashboard or extension popup to log in first')

  try {
    return await saveJob(activeSettings, job)
  } catch (error) {
    if (!isAuthFailure(error)) throw error
    const refreshed = await refreshBackgroundSettingsFromDashboard()
    if (!refreshed?.apiToken) throw error
    return saveJob(refreshed, job)
  }
}

async function scoreSavedJobWithAuthRecovery(settings: ExtensionSettings, job: SavedJob): Promise<SavedJob> {
  let activeSettings = settings
  if (!activeSettings.apiToken) {
    activeSettings = await refreshBackgroundSettingsFromDashboard() ?? activeSettings
  }
  if (!activeSettings.apiToken) throw new Error('Not logged in — open the ApplyMate dashboard or extension popup to log in first')

  try {
    return await scoreSavedJob(activeSettings, job)
  } catch (error) {
    if (!isAuthFailure(error)) throw error
    const refreshed = await refreshBackgroundSettingsFromDashboard()
    if (!refreshed?.apiToken) throw error
    return scoreSavedJob(refreshed, job)
  }
}

async function getRecentJobsWithAuthRecovery(settings: ExtensionSettings): Promise<SavedJob[]> {
  let activeSettings = settings
  if (!activeSettings.apiToken) activeSettings = await refreshBackgroundSettingsFromDashboard() ?? activeSettings
  if (!activeSettings.apiToken) throw new Error('Not logged in — open the ApplyMate dashboard or extension popup to reconnect')

  try {
    return await getRecentJobs(activeSettings)
  } catch (error) {
    if (!isAuthFailure(error)) throw error
    const refreshed = await refreshBackgroundSettingsFromDashboard()
    if (!refreshed?.apiToken) throw error
    return getRecentJobs(refreshed)
  }
}

async function getStatsWithAuthRecovery(settings: ExtensionSettings): Promise<DashboardStats> {
  let activeSettings = settings
  if (!activeSettings.apiToken) activeSettings = await refreshBackgroundSettingsFromDashboard() ?? activeSettings
  if (!activeSettings.apiToken) throw new Error('Not logged in — open the ApplyMate dashboard or extension popup to reconnect')

  try {
    return await getStats(activeSettings)
  } catch (error) {
    if (!isAuthFailure(error)) throw error
    const refreshed = await refreshBackgroundSettingsFromDashboard()
    if (!refreshed?.apiToken) throw error
    return getStats(refreshed)
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
    chrome.tabs.create({ url: 'https://applymate.site' })
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
    // Chrome only accepts sidePanel.open() while the original user gesture
    // is still alive. A content-script click reaches this listener with that
    // gesture, but awaiting getSettings() first (the normal message path)
    // consumes it. Handle content-script panel requests synchronously and
    // open the tab-specific panel before any other async work.
    if ((msg.type === 'OPEN_SIDE_PANEL' || msg.type === 'OPEN_SIDE_PANEL_TAB') && sender.tab?.id !== undefined) {
      if (!isTrustedExtensionSender(sender)) {
        try { sendResponse({ error: 'Unauthorized sender' }) } catch { /* port already closed */ }
        return false
      }

      if (msg.type === 'OPEN_SIDE_PANEL_TAB') {
        void chrome.storage.local.set({ pendingSidePanelTab: { tab: msg.tab, createdAt: Date.now() } }).catch(() => {})
        chrome.runtime.sendMessage(msg).catch(() => {})
      }

      chrome.sidePanel.open({ tabId: sender.tab.id })
        .then(() => {
          console.log('[ApplyMate] Side panel opened from content-script gesture')
          try { sendResponse({ ok: true }) } catch { /* port already closed */ }
        })
        .catch(error => {
          const message = error instanceof Error ? error.message : String(error)
          console.error('[ApplyMate] Native side panel could not be opened:', message)
          try { sendResponse({ ok: false, error: message }) } catch { /* port already closed */ }
        })
      return true
    }

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
      const stats = await getStatsWithAuthRecovery(settings)
      return { type: 'STATS_RESULT', stats }
    }

    case 'REFRESH_DASHBOARD_TOKEN': {
      const refreshed = await refreshBackgroundSettingsFromDashboard()
      return { ok: Boolean(refreshed?.apiToken) }
    }

    case 'JOB_SCRAPED': {
      const detectedAt = msg.job.detectedAt ?? Date.now()
      if (detectedAt < latestJobDetectedAt) return { ok: true, stale: true }
      latestJobDetectedAt = detectedAt
      await setCurrentJob(msg.job, settings.userEmail)
      setBadge('1', '#4F46E5')
      // Keep an already-open Popup/Side Panel in sync with the active page.
      chrome.runtime.sendMessage({ type: 'JOB_SCRAPED', job: msg.job }).catch(() => {})

      // Auto-enrich: if we previously saved this job from a list page (no description),
      // patch it now that the user has visited the detail page.
      // Rate limited: max once per URL per 30s window.
      if (settings.apiToken && msg.job.description) {
        const jobId = await lookupCachedJobId(msg.job.url, settings.userEmail)
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

    case 'JOB_MATCHED': {
      // Match scores are already persisted by the caller through the shared
      // API client. Broadcast the canonical record so Popup and Side Panel
      // refresh their views without maintaining separate match caches.
      chrome.runtime.sendMessage({ type: 'JOB_MATCHED', job: msg.job }).catch(() => {})
      return { ok: true }
    }

    case 'MATCH_JOB': {
      try {
        const updatedJob = await scoreSavedJobWithAuthRecovery(settings, msg.job)
        chrome.runtime.sendMessage({ type: 'JOB_MATCHED', job: updatedJob }).catch(() => {})
        return { type: 'MATCH_JOB_RESULT', success: true, job: updatedJob }
      } catch (error) {
        return { type: 'MATCH_JOB_RESULT', success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }

    case 'SAVE_JOB': {
      try {
        const key = getJobIdentity(msg.job)
        const cached = savedJobsByKey.get(key)
        if (cached) {
          chrome.runtime.sendMessage({ type: 'JOB_SAVED', savedJob: cached }).catch(() => {})
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
          await cacheJobUrl(msg.job.url, savedJob.id, settings.userEmail)
        }
        setBadge('✓', '#3B6D11')
        setTimeout(clearBadge, 3000)
        chrome.runtime.sendMessage({ type: 'JOB_SAVED', savedJob }).catch(() => {})
        return { type: 'SAVE_JOB_RESULT', success: true, savedJob }
      } catch (err) {
        pendingSavesByKey.delete(getJobIdentity(msg.job))
        const error = err instanceof Error ? err.message : String(err)
        return { type: 'SAVE_JOB_RESULT', success: false, error }
      }
    }

    case 'GET_RECENT_JOBS': {
      const jobs = await getRecentJobsWithAuthRecovery(settings)
      return { type: 'RECENT_JOBS_RESULT', jobs }
    }

    case 'OPEN_SIDE_PANEL': {
      return openTrackerWindow()
    }

    case 'OPEN_SIDE_PANEL_TAB': {
      // Opening the native panel and selecting its destination are two separate
      // operations. Persist the target so a freshly-created side panel cannot
      // lose the user's intent while its React page is still mounting.
      await chrome.storage.local.set({ pendingSidePanelTab: { tab: msg.tab, createdAt: Date.now() } })
      chrome.runtime.sendMessage(msg).catch(() => {})
      return { ok: true }
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
  try {
    // Do not await getLastFocused() here. The function is also used by the
    // keyboard shortcut path, where sidePanel.open() must remain in the same
    // user-gesture turn. WINDOW_ID_CURRENT is valid for the current window.
    await chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT })
    console.log('[ApplyMate] Side panel opened natively')
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[ApplyMate] Native side panel could not be opened:', message)
    return { ok: false, error: message }
  }
  return { ok: false, error: 'No focused browser window' }
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
    const settings = await getSettings()
    await setCurrentJob(null, settings.userEmail)
  }
})
