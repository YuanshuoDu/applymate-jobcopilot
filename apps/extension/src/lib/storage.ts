import type { ExtensionSettings, ScrapedJob } from './types'

const DEFAULTS: ExtensionSettings = {
  apiBaseUrl: 'https://applymate.site',
  apiToken:   '',
  userEmail:  '',
  userName:   '',
  autoSave:   true,
}

const STORAGE_TIMEOUT_MS = 2000
const CANONICAL_API_ORIGIN = 'https://applymate.site'
const DEV_API_ORIGINS = new Set(['http://localhost:3000', 'http://localhost:5173'])

/** Keep bearer tokens on the canonical HTTPS service; localhost is dev-only. */
export function normalizeApiBaseUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim())
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null
    if (url.origin === CANONICAL_API_ORIGIN || DEV_API_ORIGINS.has(url.origin)) return url.origin
    return null
  } catch {
    return null
  }
}

function getSyncStorage(): chrome.storage.StorageArea | null {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.sync) return null
    return chrome.storage.sync
  } catch {
    return null
  }
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Chrome storage timed out')), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ── Settings (sync — shared across devices) ───────────────────

export async function getSettings(): Promise<ExtensionSettings> {
  try {
    const syncStorage = getSyncStorage()
    if (!syncStorage) return { ...DEFAULTS }
    const result = await within(syncStorage.get('settings'), STORAGE_TIMEOUT_MS)
    const stored = (result.settings ?? {}) as Partial<ExtensionSettings>
    const apiBaseUrl = normalizeApiBaseUrl(stored.apiBaseUrl ?? DEFAULTS.apiBaseUrl)
    if (!apiBaseUrl) {
      // Never reuse a token that was configured for an untrusted origin.
      return { ...DEFAULTS }
    }
    return { ...DEFAULTS, ...stored, apiBaseUrl }
  } catch (error) {
    console.warn('[ApplyMate] Settings load failed; using defaults:', error)
    return { ...DEFAULTS }
  }
}

export async function saveSettings(partial: Partial<ExtensionSettings>): Promise<void> {
  const current = await getSettings()
  const syncStorage = getSyncStorage()
  if (!syncStorage) return
  if (partial.apiBaseUrl !== undefined) {
    const apiBaseUrl = normalizeApiBaseUrl(partial.apiBaseUrl)
    if (!apiBaseUrl) {
      throw new Error('API URL must be https://applymate.site or a documented localhost development server.')
    }
    partial = { ...partial, apiBaseUrl }
  }
  try {
    await syncStorage.set({ settings: { ...current, ...partial } })
  } catch (error) {
    console.warn('[ApplyMate] Settings save skipped:', error)
  }
}

export async function clearAuth(): Promise<void> {
  await saveSettings({ apiToken: '', userEmail: '', userName: '' })
}

export function isLoggedIn(settings: ExtensionSettings): boolean {
  return !!settings.apiToken && !!settings.userEmail
}

// ── Current page job (local — tab-specific) ───────────────────

export async function setCurrentJob(job: ScrapedJob | null): Promise<void> {
  await chrome.storage.local.set({ currentJob: job })
}

export async function getCurrentJob(): Promise<ScrapedJob | null> {
  const result = await chrome.storage.local.get('currentJob')
  return result.currentJob ?? null
}

// ── Badge helpers ─────────────────────────────────────────────

export function setBadge(text: string, color = '#4F46E5') {
  chrome.action.setBadgeText({ text })
  chrome.action.setBadgeBackgroundColor({ color })
}

export function clearBadge() {
  chrome.action.setBadgeText({ text: '' })
}

// ── Resume helpers ────────────────────────────────────────────────

export async function setCurrentResumeId(id: string): Promise<void> {
  await chrome.storage.local.set({ currentResumeId: id })
}

export async function getCurrentResumeId(): Promise<string | null> {
  const result = await chrome.storage.local.get('currentResumeId')
  return result.currentResumeId ?? null
}

export async function setResumeDraft(resumeId: string, content: object): Promise<void> {
  await chrome.storage.local.set({ [`resumeDraft:${resumeId}`]: { content, ts: Date.now() } })
}

export async function getResumeDraft(resumeId: string): Promise<{ content: object; ts: number } | null> {
  const result = await chrome.storage.local.get(`resumeDraft:${resumeId}`)
  const draft = result[`resumeDraft:${resumeId}`]
  if (!draft) return null
  // Discard drafts older than 24h
  if (Date.now() - draft.ts > 86400000) {
    await chrome.storage.local.remove(`resumeDraft:${resumeId}`)
    return null
  }
  return draft
}

export async function clearResumeDraft(resumeId: string): Promise<void> {
  await chrome.storage.local.remove(`resumeDraft:${resumeId}`)
}
