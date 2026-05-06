/**
 * API client for communicating with the ApplyMate Next.js backend.
 * Uses a long-lived JWT token stored in chrome.storage.sync.
 */
import type { ScrapedJob, SavedJob, DashboardStats, ExtensionSettings } from './types'

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function request<T>(
  settings: ExtensionSettings,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${settings.apiBaseUrl}${path}`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> ?? {}),
  }
  if (settings.apiToken) {
    headers['Authorization'] = `Bearer ${settings.apiToken}`
  }

  let lastError: Error | null = null
  // Retry once on network error
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        ...options,
        headers,
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }))
        throw new ApiError(res.status, body.error ?? 'Request failed')
      }
      return res.json()
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (err instanceof ApiError) throw err // Don't retry API errors
      if (attempt === 0) await new Promise(r => setTimeout(r, 800))
    }
  }
  throw lastError
}

// ── Auth ──────────────────────────────────────────────────────

export interface LoginResult {
  token:     string
  expiresAt: string
  user: {
    id:    string
    email: string
    name:  string | null
    plan:  string
  }
}

export async function login(
  settings: ExtensionSettings,
  email: string,
  password: string,
): Promise<LoginResult> {
  return request<LoginResult>(settings, '/api/auth/extension-token', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
}

// ── Jobs ──────────────────────────────────────────────────────

export async function saveJob(
  settings: ExtensionSettings,
  job: ScrapedJob,
): Promise<SavedJob> {
  return request<SavedJob>(settings, '/api/jobs', {
    method: 'POST',
    body: JSON.stringify({
      company:     job.company,
      role:        job.title,
      location:    job.location,
      url:         job.url,
      description: job.description,
      salary:      job.salary,
      source:      job.source,
      status:      'saved',
    }),
  })
}

export async function getRecentJobs(settings: ExtensionSettings): Promise<SavedJob[]> {
  const data = await request<{ jobs: SavedJob[]; total: number }>(
    settings, '/api/jobs?pageSize=20',
  )
  return data.jobs
}

export async function updateJobStatus(
  settings: ExtensionSettings,
  jobId: string,
  status: string,
): Promise<SavedJob> {
  return request<SavedJob>(settings, `/api/jobs/${jobId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  })
}

export async function updateJobNotes(
  settings: ExtensionSettings,
  jobId: string,
  notes: string,
): Promise<SavedJob> {
  return request<SavedJob>(settings, `/api/jobs/${jobId}`, {
    method: 'PATCH',
    body: JSON.stringify({ notes }),
  })
}

// ── Dashboard stats ───────────────────────────────────────────

export async function getStats(settings: ExtensionSettings): Promise<DashboardStats> {
  const data = await request<{ stats: DashboardStats }>(settings, '/api/dashboard')
  return data.stats
}
