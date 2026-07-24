/**
 * API client for communicating with the ApplyMate Next.js backend.
 * Uses a long-lived JWT token stored in chrome.storage.sync.
 */
import type { ScrapedJob, SavedJob, DashboardStats, ExtensionSettings, ResumeListItem, Resume, ScoreResult, Suggestion } from './types'
import type { FormFillRequest, FormFillResponse, FormReviseRequest } from './form-filler/types'

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

interface RequestExtras {
  /** Override the default fetch timeout in ms. Default 15_000. AI calls use 120_000. */
  _timeoutMs?: number
  /** Whether to retry on timeout/network error. Default true for non-AI calls. */
  _retry?: boolean
}

async function request<T>(
  settings: ExtensionSettings,
  path: string,
  options: RequestInit & RequestExtras = {},
): Promise<T> {
  const { _timeoutMs = 15_000, _retry = true, ...fetchOpts } = options
  const url = `${settings.apiBaseUrl}${path}`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(fetchOpts.headers as Record<string, string> ?? {}),
  }
  if (settings.apiToken) {
    headers['Authorization'] = `Bearer ${settings.apiToken}`
  }

  let lastError: Error | null = null
  const maxAttempts = _retry ? 2 : 1
  // Retry once on network error (only for non-AI calls)
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        ...fetchOpts,
        headers,
        signal: AbortSignal.timeout(_timeoutMs),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }))
        throw new ApiError(res.status, body.error ?? 'Request failed')
      }
      return res.json()
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (err instanceof ApiError) throw err // Don't retry API errors
      // Don't retry timeouts — the server is likely still processing
      if (err instanceof DOMException && err.name === 'AbortError' && lastError.message.includes('timed out')) break
      if (attempt < maxAttempts - 1) await new Promise(r => setTimeout(r, 800))
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

export async function exportApplicationPackLocally(settings: ExtensionSettings, jobId: string, openFolder = false): Promise<{ folderPath: string; opened: boolean }> {
  return request(settings, `/api/jobs/${jobId}/export-local`, {
    method: 'POST', body: JSON.stringify({ openFolder, openOnly: openFolder }), _timeoutMs: 120_000, _retry: false,
  })
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

export async function updateJob(
  settings: ExtensionSettings,
  jobId: string,
  fields: Partial<{ description: string; salary: string | null; location: string }>,
): Promise<SavedJob> {
  return request<SavedJob>(settings, `/api/jobs/${jobId}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  })
}

// ── Dashboard stats ───────────────────────────────────────────

export async function getStats(settings: ExtensionSettings): Promise<DashboardStats> {
  const data = await request<{ stats: DashboardStats }>(settings, '/api/dashboard')
  return data.stats
}

// ── Persona ─────────────────────────────────────────────────────

export interface PersonaResult {
  persona: string
}

export interface PersonaField {
  key:        string
  category:   string  // "personal" | "work" | "contact" | "education" | "preferences"
  label:      string
  value:      string
  confidence: number
  source:     string  // "resume" | "ai_derived" | "manual" | "form_scan"
  updatedAt:  string
}

export interface PersonaFieldsResult {
  fields: PersonaField[]
}

export async function getPersona(settings: ExtensionSettings): Promise<PersonaResult> {
  return request<PersonaResult>(settings, '/api/me/persona')
}

export async function getPersonaFields(settings: ExtensionSettings): Promise<PersonaFieldsResult> {
  return request<PersonaFieldsResult>(settings, '/api/me/persona/fields')
}

export async function savePersonaFields(settings: ExtensionSettings, fields: PersonaField[]): Promise<PersonaFieldsResult> {
  return request<PersonaFieldsResult>(settings, '/api/me/persona/fields', {
    method: 'POST',
    body: JSON.stringify({ fields }),
  })
}

export async function deletePersonaField(settings: ExtensionSettings, key: string): Promise<void> {
  await request(settings, '/api/me/persona/fields', {
    method: 'DELETE',
    body: JSON.stringify({ key }),
  })
}

// ── Form Filler ─────────────────────────────────────────────────

/** AI calls may take 30-120s for multi-field form analysis */
const AI_TIMEOUT = 180_000 // 3 min — 37+ fields can be heavy

export async function analyzeForm(
  settings: ExtensionSettings,
  body: FormFillRequest,
): Promise<FormFillResponse> {
  return request<FormFillResponse>(settings, '/api/ai/form-fill', {
    method: 'POST',
    body: JSON.stringify(body),
    _timeoutMs: AI_TIMEOUT,
    _retry: false,
  })
}

export async function reviseFormFields(
  settings: ExtensionSettings,
  body: FormReviseRequest,
): Promise<FormFillResponse> {
  return request<FormFillResponse>(settings, '/api/ai/form-fill/revise', {
    method: 'POST',
    body: JSON.stringify(body),
    _timeoutMs: AI_TIMEOUT,
    _retry: false,
  })
}

// ── Resume ────────────────────────────────────────────────────────

export async function listResumes(settings: ExtensionSettings): Promise<ResumeListItem[]> {
  return request<ResumeListItem[]>(settings, '/api/resume')
}

export async function getResume(settings: ExtensionSettings, id: string): Promise<Resume> {
  return request<Resume>(settings, `/api/resume/${id}`)
}

export async function createResume(settings: ExtensionSettings, body: {
  name: string; content: object; templateId?: string; isDefault?: boolean
}): Promise<Resume> {
  return request<Resume>(settings, '/api/resume', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function updateResume(settings: ExtensionSettings, id: string, body: {
  name?: string; content?: object; templateId?: string | null
  templateOptions?: object | null; isDefault?: boolean
}): Promise<Resume> {
  return request<Resume>(settings, `/api/resume/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function deleteResume(settings: ExtensionSettings, id: string): Promise<void> {
  await request(settings, `/api/resume/${id}`, { method: 'DELETE' })
}

// ── AI Resume scoring & suggestions ───────────────────────────────

export async function scoreResume(settings: ExtensionSettings, body: {
  resumeContent: object; jobTitle?: string; jobCompany?: string
  jobDescription?: string; keySkills?: string[]
}): Promise<ScoreResult> {
  return request<ScoreResult>(settings, '/api/ai/score', {
    method: 'POST',
    body: JSON.stringify(body),
    _timeoutMs: AI_TIMEOUT,
    _retry: false,
  })
}

export async function suggestResume(settings: ExtensionSettings, body: {
  resumeContent: object; jobTitle?: string; jobCompany?: string; jobDescription?: string
}): Promise<{ suggestions: Suggestion[]; _model?: string }> {
  return request<{ suggestions: Suggestion[] }>(settings, '/api/ai/suggest', {
    method: 'POST',
    body: JSON.stringify(body),
    _timeoutMs: AI_TIMEOUT,
    _retry: false,
  })
}
