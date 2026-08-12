import { getJobIdentity } from '@/lib/job-identity'
import type { DashboardStats, SavedJob, ScrapedJob } from '@/lib/types'
import { LABELS, type PopupLabels } from './popup-constants'

export function getLabels(): PopupLabels {
  try {
    const lang = localStorage.getItem('applymate_lang') ?? ''
    if (LABELS[lang]) return LABELS[lang]
  } catch { /* extension storage may be unavailable in a preview */ }
  return LABELS.en
}

export function isScrapedJob(value: unknown): value is ScrapedJob {
  if (!value || typeof value !== 'object') return false
  const job = value as Partial<ScrapedJob>
  return typeof job.title === 'string' && typeof job.company === 'string' && typeof job.url === 'string'
}

export function isSavedJobsResponse(value: unknown): value is { jobs: SavedJob[] } {
  if (!value || typeof value !== 'object') return false
  const response = value as { jobs?: unknown }
  return Array.isArray(response.jobs)
}

export function isStatsResponse(value: unknown): value is { stats: DashboardStats } {
  if (!value || typeof value !== 'object') return false
  const response = value as { stats?: unknown }
  return !!response.stats && typeof response.stats === 'object'
}

export function isSaveResponse(value: unknown): value is { success?: boolean; savedJob?: SavedJob; error?: string } {
  return !!value && typeof value === 'object'
}

export function isCurrentJobResponse(value: unknown): value is { type: 'CURRENT_JOB_RESULT'; job: ScrapedJob | null } {
  if (!value || typeof value !== 'object') return false
  const response = value as { type?: unknown; job?: unknown }
  return response.type === 'CURRENT_JOB_RESULT' && (response.job === null || isScrapedJob(response.job))
}

export function sourceLabel(source: string): string {
  return source === 'linkedin' ? 'LinkedIn' : source === 'indeed' ? 'Indeed' : source === 'unknown' ? 'Job page' : source[0].toUpperCase() + source.slice(1)
}

export function companyDomain(company: string): string {
  const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, '')
  return slug ? `https://www.google.com/s2/favicons?domain=${slug}.com&sz=128` : ''
}

export function sameJob(job: ScrapedJob, saved: SavedJob): boolean {
  if (job.url && saved.url && job.url === saved.url) return true
  return getJobIdentity(job) === getJobIdentity({
    source: saved.source ?? undefined,
    url: saved.url ?? undefined,
    role: saved.role,
    company: saved.company,
    location: saved.location ?? undefined,
  })
}

export function companyInitials(company: string): string {
  return company.trim().split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase() || 'A'
}

export function openSidePanel(windowId: number): Promise<void> {
  // Keep this API call in the Popup click handler. Chrome requires the live
  // user gesture and rejects a later Service Worker call as a new action.
  return chrome.sidePanel.open({ windowId })
}
