/**
 * ApplyMate AI — Background Service Worker
 * Handles: message routing, API calls, badge updates, side panel
 */
import { getSettings, saveSettings, setCurrentJob, setBadge, clearBadge } from '@/lib/storage'
import { login, saveJob, getRecentJobs, getStats } from '@/lib/api'
import type { ExtMessage, ScrapedJob } from '@/lib/types'

// ── Lifecycle ─────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    chrome.tabs.create({ url: 'http://localhost:3000' })
  }
})

// ── Side panel: open on action click ─────────────────────────

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error)

// ── Message handler ───────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (msg: ExtMessage, _sender, sendResponse) => {
    handleMessage(msg).then(sendResponse).catch(err => {
      sendResponse({ error: String(err) })
    })
    return true // keep channel open for async response
  },
)

async function handleMessage(msg: ExtMessage): Promise<unknown> {
  const settings = await getSettings()

  switch (msg.type) {
    case 'PING':
      return { type: 'PONG' }

    // ── Auth ────────────────────────────────────────────────
    case 'GET_STATS': {
      if (!settings.apiToken) return { type: 'STATS_RESULT', stats: null }
      const stats = await getStats(settings)
      return { type: 'STATS_RESULT', stats }
    }

    // ── Job scraped by content script ────────────────────────
    case 'JOB_SCRAPED': {
      await setCurrentJob(msg.job)
      setBadge('1', '#185FA5')
      return { ok: true }
    }

    // ── Save job ─────────────────────────────────────────────
    case 'SAVE_JOB': {
      if (!settings.apiToken) {
        return { type: 'SAVE_JOB_RESULT', success: false, error: 'Not logged in' }
      }
      try {
        const savedJob = await saveJob(settings, msg.job)
        setBadge('✓', '#3B6D11')
        setTimeout(clearBadge, 3000)
        return { type: 'SAVE_JOB_RESULT', success: true, savedJob }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        return { type: 'SAVE_JOB_RESULT', success: false, error }
      }
    }

    // ── Get recent jobs ───────────────────────────────────────
    case 'GET_RECENT_JOBS': {
      if (!settings.apiToken) return { type: 'RECENT_JOBS_RESULT', jobs: [] }
      const jobs = await getRecentJobs(settings)
      return { type: 'RECENT_JOBS_RESULT', jobs }
    }

    // ── Open side panel ───────────────────────────────────────
    case 'OPEN_SIDE_PANEL': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (tab?.id) {
        await chrome.sidePanel.open({ tabId: tab.id })
      }
      return { ok: true }
    }

    default:
      return { error: 'Unknown message type' }
  }
}

// ── Tab navigation: clear badge on new page ───────────────────

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete') return
  if (!tab.url) return

  // Check if the new URL is a job page
  const JOB_PATTERNS = [
    /linkedin\.com\/jobs\/(view|search)/,
    /indeed\.com\/viewjob/,
    /glassdoor\.com\/(job-listing|Jobs)/,
    /stepstone\.(de|at|ch|be|nl|fr)\//,
    /xing\.com\/jobs\//,
    /wellfound\.com\/jobs\//,
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

// ── Keep service worker alive during dev ──────────────────────
// (production: service workers auto-terminate when idle, that's OK)
