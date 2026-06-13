import type { ExtensionSettings, ScrapedJob } from './types'

const DEFAULTS: ExtensionSettings = {
  apiBaseUrl: 'https://web-delta-ruddy-29.vercel.app',
  apiToken:   '',
  userEmail:  '',
  userName:   '',
  autoSave:   true,
}

// ── Settings (sync — shared across devices) ───────────────────

export async function getSettings(): Promise<ExtensionSettings> {
  const result = await chrome.storage.sync.get('settings')
  return { ...DEFAULTS, ...(result.settings ?? {}) }
}

export async function saveSettings(partial: Partial<ExtensionSettings>): Promise<void> {
  const current = await getSettings()
  await chrome.storage.sync.set({ settings: { ...current, ...partial } })
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

export function setBadge(text: string, color = '#185FA5') {
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
