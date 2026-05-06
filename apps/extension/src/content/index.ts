/**
 * ApplyMate AI — Content Script
 * Two modes:
 *  • List page  (LinkedIn search / Indeed results) → per-card ⊕ button + hover popup
 *  • Detail page (single JD)                       → fixed bottom-right save button
 */
import { detectAndScrape } from '@/lib/scrapers/detect'
import { startListModeInjector, isJobListPage } from './list-injector'
import type { ScrapedJob } from '@/lib/types'

const BUTTON_ID = 'applymate-save-btn'
const TOAST_ID  = 'applymate-toast'

let currentJob: ScrapedJob | null = null
let injectAttempts = 0

// ── Entry point ───────────────────────────────────────────────────────────────

function init() {
  if (isJobListPage()) {
    // LIST MODE: inject per-card buttons + hover popups
    startListModeInjector()
  } else {
    // DETAIL MODE: inject single fixed save button
    currentJob = detectAndScrape()
    if (currentJob) {
      chrome.runtime.sendMessage({ type: 'JOB_SCRAPED', job: currentJob })
      chrome.storage.local.set({ currentJob })
      injectDetailButton()
    }
  }
}

// Retry for SPAs where content loads after navigation
function scheduleRetry() {
  injectAttempts = 0
  const interval = setInterval(() => {
    if (injectAttempts++ > 10) { clearInterval(interval); return }

    if (isJobListPage()) {
      clearInterval(interval)
      startListModeInjector()
      return
    }

    if (document.getElementById(BUTTON_ID)) { clearInterval(interval); return }
    currentJob = detectAndScrape()
    if (currentJob) {
      chrome.runtime.sendMessage({ type: 'JOB_SCRAPED', job: currentJob })
      chrome.storage.local.set({ currentJob })
      injectDetailButton()
      clearInterval(interval)
    }
  }, 800)
}

// SPA navigation detection
let lastUrl = location.href
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href
    document.getElementById(BUTTON_ID)?.remove()
    document.getElementById(TOAST_ID)?.remove()
    currentJob = null
    scheduleRetry()
  }
}).observe(document.body, { subtree: true, childList: true })

init()
setTimeout(scheduleRetry, 1500)

// ── Detail mode: fixed save button ───────────────────────────────────────────

function injectDetailButton() {
  if (document.getElementById(BUTTON_ID)) return
  if (!currentJob) return

  const btn = document.createElement('button')
  btn.id = BUTTON_ID
  btn.innerHTML = `<span style="font-size:13px">⊕</span><span>Save to ApplyMate</span>`

  Object.assign(btn.style, {
    position: 'fixed', bottom: '24px', right: '24px', zIndex: '2147483647',
    display: 'flex', alignItems: 'center', gap: '6px', padding: '10px 16px',
    background: '#185FA5', color: '#fff', border: 'none', borderRadius: '8px',
    fontSize: '13px', fontWeight: '500',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    cursor: 'pointer', boxShadow: '0 4px 12px rgba(24,95,165,0.35)',
    transition: 'all 0.15s',
  })

  btn.addEventListener('mouseenter', () => {
    btn.style.background = '#1a6dbf'
    btn.style.transform  = 'translateY(-1px)'
  })
  btn.addEventListener('mouseleave', () => {
    btn.style.background = '#185FA5'
    btn.style.transform  = ''
  })
  btn.addEventListener('click', () => saveDetailJob(btn))
  document.body.appendChild(btn)
}

async function saveDetailJob(btn: HTMLButtonElement) {
  if (!currentJob) return
  const original = btn.innerHTML
  btn.innerHTML = '<span>Saving…</span>'
  btn.style.opacity = '0.7'

  const response = await chrome.runtime.sendMessage({ type: 'SAVE_JOB', job: currentJob })

  if (response?.success) {
    btn.innerHTML = '✓ Saved!'
    btn.style.background = '#3B6D11'
    btn.style.opacity    = '1'
    showToast(`Saved: ${currentJob.title} @ ${currentJob.company}`)
    setTimeout(() => btn.remove(), 2500)
  } else {
    const msg = response?.error ?? 'Save failed'
    btn.innerHTML     = msg.includes('login') ? '⚠ Log in first' : '✗ Error'
    btn.style.background = '#A32D2D'
    btn.style.opacity    = '1'
    setTimeout(() => { btn.innerHTML = original; btn.style.background = '#185FA5' }, 2000)
  }
}

function showToast(message: string) {
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
    transition: 'opacity 0.3s', maxWidth: '280px',
  })
  document.body.appendChild(toast)
  requestAnimationFrame(() => { toast.style.opacity = '1' })
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300) }, 3000)
}
