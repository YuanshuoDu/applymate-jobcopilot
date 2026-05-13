/**
 * ApplyMate AI — Background Service Worker
 * Handles: message routing, API calls, badge updates, side panel
 */
import { getSettings, saveSettings, setCurrentJob, setBadge, clearBadge } from '@/lib/storage'
import { login, saveJob, getRecentJobs, getStats, updateJob } from '@/lib/api'
import type { ExtMessage, ExtensionSettings, ScrapedJob } from '@/lib/types'

// ── Simple rate limiter (prevent excessive API calls) ──────────────
const RATE_LIMIT_WINDOW = 2000 // 2 seconds between same-type operations
const rateLimitMap = new Map<string, number>()

function checkRateLimit(key: string): boolean {
  const now = Date.now()
  const last = rateLimitMap.get(key)
  if (last && now - last < RATE_LIMIT_WINDOW) return false
  rateLimitMap.set(key, now)
  return true
}

// Clean up rate limit map periodically to prevent memory leaks
setInterval(() => {
  const now = Date.now()
  for (const [key, time] of rateLimitMap.entries()) {
    if (now - time > 60000) rateLimitMap.delete(key)
  }
}, 60000)

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

// ── Lifecycle ─────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    chrome.tabs.create({ url: 'http://localhost:3000' })
  }

  // Let Chrome show the side panel button in the toolbar
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })
  } catch { /* Chrome < 116 doesn't support setPanelBehavior */ }
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
    handleMessage(msg, sender).then(sendResponse).catch(err => {
      sendResponse({ error: String(err) })
    })
    return true
  },
)

async function handleMessage(
  msg: ExtMessage,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  let settings = await getSettings()

  // Auto-detect localhost: force API URL to localhost for local testing
  const senderUrl = sender.url ?? sender.origin ?? ''
  const isLocalhost = senderUrl.includes('localhost') || senderUrl.includes('127.0.0.1')
  if (isLocalhost && settings.apiBaseUrl !== 'http://localhost:3000') {
    console.log('[ApplyMate] Localhost detected, switching API from', settings.apiBaseUrl, 'to http://localhost:3000')
    // Clear old token (it was issued by a different server — invalid for localhost)
    settings = { ...settings, apiBaseUrl: 'http://localhost:3000', apiToken: '', userEmail: '', userName: '' }
    await saveSettings({ apiBaseUrl: 'http://localhost:3000', apiToken: '', userEmail: '', userName: '' })
  }

  switch (msg.type) {
    case 'PING':
      return { type: 'PONG', settings: { hasToken: !!settings.apiToken, email: settings.userEmail, apiBaseUrl: settings.apiBaseUrl } }

    case 'GET_STATS': {
      if (!settings.apiToken) return { type: 'STATS_RESULT', stats: null }
      const stats = await getStats(settings)
      return { type: 'STATS_RESULT', stats }
    }

    case 'JOB_SCRAPED': {
      await setCurrentJob(msg.job)
      setBadge('1', '#185FA5')

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
      if (!settings.apiToken) {
        return { type: 'SAVE_JOB_RESULT', success: false, error: 'Not logged in — open the extension popup to log in first' }
      }
      // Rate limit: prevent duplicate saves for same URL within 2s
      if (msg.job?.url && !checkRateLimit(`save:${msg.job.url}`)) {
        return { type: 'SAVE_JOB_RESULT', success: false, error: 'Rate limited — please wait a moment' }
      }
      try {
        const savedJob = await saveJob(settings, msg.job)
        // Cache URL→jobId for later auto-enrichment when user visits the detail page
        if (savedJob?.id && msg.job.url) {
          await cacheJobUrl(msg.job.url, savedJob.id)
        }
        setBadge('✓', '#3B6D11')
        setTimeout(clearBadge, 3000)
        return { type: 'SAVE_JOB_RESULT', success: true, savedJob }
      } catch (err) {
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
  if (info.status !== 'complete') return
  if (!tab.url) return

  const JOB_PATTERNS = [
    /linkedin\.com\/jobs/,
    /indeed\.com\/(viewjob|jobs)/,
    /indeed\.com\/\?q=/,
    /glassdoor\.com\/(Job|job-listing|Jobs)/,
    /stepstone\.(de|at|ch|be|nl|fr)\//,
    /xing\.com\/jobs\//,
    /wellfound\.com\//,
    /greenhouse\.io\/jobs\//,
    /lever\.co\//,
    /myworkdayjobs\.com\//,
  ]
  const isJobPage = JOB_PATTERNS.some(p => p.test(tab.url!))

  if (!isJobPage) {
    clearBadge()
    await setCurrentJob(null)
  }
})
