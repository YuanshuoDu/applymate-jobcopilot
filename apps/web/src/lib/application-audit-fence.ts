import type { ApplicationAudit } from './types'
import type { StoredApplicationAudit } from './application-audit'

/** A same-tab fence only; other tabs, cleared storage and devices do not share it. */
export const APPLICATION_AUDIT_FENCE_EVENT = 'applymate:application-audit-fence'

type Pending = { version: 1; state: 'pending'; attemptId: string; resumeId: string; coverLetterId: string | null }
type Confirmed = Omit<Pending, 'state'> & { state: 'confirmed'; operationId: string; resumeUpdatedAt: string; coverLetterUpdatedAt: string | null; digest: string }
type Fence = Pending | Confirmed
export type AuditFenceRead = { state: 'none' | 'unavailable' } | { state: 'pending' | 'confirmed'; fence: Fence }
export type AuditFencePost = ApplicationAudit & { operationId?: string; resumeUpdatedAt?: string; coverLetterUpdatedAt?: string }
export type AuditPostResult = { data: AuditFencePost | null; error: string | null; preflightRejected: boolean }

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const hash = /^[a-f0-9]{64}$/
const key = (userId: string, jobId: string) => `applymate:audit-fence:${encodeURIComponent(userId)}:${encodeURIComponent(jobId)}`
const validDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))

export function auditFenceStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage } catch { return null }
}

function notify() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(APPLICATION_AUDIT_FENCE_EVENT))
}

function parse(raw: string): Fence | null {
  try {
    const v: unknown = JSON.parse(raw)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    const row = v as Record<string, unknown>
    if (row.version !== 1 || typeof row.attemptId !== 'string' || !uuid.test(row.attemptId)
      || typeof row.resumeId !== 'string' || !row.resumeId || !(row.coverLetterId === null || typeof row.coverLetterId === 'string' && row.coverLetterId.length > 0)) return null
    const names = Object.keys(row).sort().join(',')
    if (row.state === 'pending' && names === 'attemptId,coverLetterId,resumeId,state,version') return row as Pending
    if (row.state !== 'confirmed' || names !== 'attemptId,coverLetterId,coverLetterUpdatedAt,digest,operationId,resumeId,resumeUpdatedAt,state,version'
      || typeof row.operationId !== 'string' || !uuid.test(row.operationId) || !validDate(row.resumeUpdatedAt)
      || (row.coverLetterId === null ? row.coverLetterUpdatedAt !== null : !validDate(row.coverLetterUpdatedAt))
      || typeof row.digest !== 'string' || !hash.test(row.digest)) return null
    return row as Confirmed
  } catch { return null }
}

export function readAuditFence(storage: Storage | null, userId: string, jobId: string): AuditFenceRead {
  if (!storage || !userId || !jobId) return { state: 'unavailable' }
  try {
    const raw = storage.getItem(key(userId, jobId))
    if (raw === null) return { state: 'none' }
    const fence = parse(raw)
    return fence ? { state: fence.state, fence } : { state: 'unavailable' }
  } catch { return { state: 'unavailable' } }
}

/** Register and verify before sending POST; never replace an unresolved attempt. */
export function beginAuditFence(storage: Storage | null, userId: string, jobId: string, resumeId: string, coverLetterId: string | null): string | null {
  if (!storage || !resumeId || readAuditFence(storage, userId, jobId).state !== 'none') return null
  try {
    const attemptId = crypto.randomUUID()
    if (!uuid.test(attemptId)) return null
    const fence: Pending = { version: 1, state: 'pending', attemptId, resumeId, coverLetterId }
    const raw = JSON.stringify(fence)
    if (!parse(raw)) return null
    storage.setItem(key(userId, jobId), raw)
    notify()
    return storage.getItem(key(userId, jobId)) === raw ? attemptId : null
  } catch { notify(); return null }
}

/** Clear only this request after the server certifies its handler did not register a review. */
function releaseUnregisteredAuditFence(storage: Storage | null, userId: string, jobId: string, attemptId: string): boolean {
  if (!storage) return false
  const current = readAuditFence(storage, userId, jobId)
  if (current.state !== 'pending' || current.fence.attemptId !== attemptId) return false
  try {
    storage.removeItem(key(userId, jobId))
    const removed = storage.getItem(key(userId, jobId)) === null
    notify()
    return removed
  } catch { notify(); return false }
}

/** Only a scoped, matching pre-registration certificate can release a failed request. */
export async function postApplicationAudit(
  storage: Storage | null, userId: string, jobId: string, attemptId: string,
  body: { resumeId: string; coverLetterId?: string | null },
): Promise<AuditPostResult> {
  const current = readAuditFence(storage, userId, jobId)
  if (current.state !== 'pending' || current.fence.attemptId !== attemptId
    || current.fence.resumeId !== body.resumeId || current.fence.coverLetterId !== (body.coverLetterId ?? null)) {
    return { data: null, error: 'Review request was not sent.', preflightRejected: false }
  }
  try {
    const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/audit-application`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': attemptId, 'X-Application-Audit-Attempt-Id': attemptId }, body: JSON.stringify(body),
    })
    const value: unknown = await response.json()
    const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
    if (response.ok) return { data: row as AuditFencePost | null, error: row ? null : 'Review response unavailable.', preflightRejected: false }
    const error = typeof row?.error === 'string' ? row.error : 'Request failed'
    const certified = response.status === 422 && row?.code === 'AUDIT_PRECHECK_NOT_REGISTERED'
      && row.auditRegistration === 'not_started' && row.auditAttemptId === attemptId
    return { data: null, error, preflightRejected: certified && releaseUnregisteredAuditFence(storage, userId, jobId, attemptId) }
  } catch { return { data: null, error: 'Network error', preflightRejected: false } }
}

/** A correction may release its own fence only on the explicit early no-write certificate. */
export async function postApplicationAuditCorrection<T>(
  storage: Storage | null, userId: string, jobId: string, attemptId: string,
  body: { resumeId: string; coverLetterId: string | null; findingIndex: number; auditOperationId: string },
): Promise<{ data: T | null; error: string | null; preflightRejected: boolean }> {
  const current = readAuditFence(storage, userId, jobId)
  if (current.state !== 'pending' || current.fence.attemptId !== attemptId
    || current.fence.resumeId !== body.resumeId || current.fence.coverLetterId !== body.coverLetterId) {
    return { data: null, error: 'Correction request was not sent.', preflightRejected: false }
  }
  try {
    const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/audit-application/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': attemptId, 'X-Application-Audit-Attempt-Id': attemptId }, body: JSON.stringify(body),
    })
    const value: unknown = await response.json()
    const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
    if (response.ok) return { data: row as T | null, error: row ? null : 'Correction response unavailable.', preflightRejected: false }
    const error = typeof row?.error === 'string' ? row.error : 'Request failed'
    const certified = response.status === 409 && row?.code === 'AUDIT_CORRECTION_NOT_STARTED'
      && row.correctionWrite === 'not_started' && row.auditAttemptId === attemptId
    return { data: null, error, preflightRejected: certified && releaseUnregisteredAuditFence(storage, userId, jobId, attemptId) }
  } catch { return { data: null, error: 'Network error', preflightRejected: false } }
}

function canonical(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, item]) => [name, canonical(item)]))
  }
  throw new Error('Invalid audit data')
}

async function auditDigest(audit: ApplicationAudit): Promise<string> {
  if (!audit || !['pass', 'needs_review', 'blocked'].includes(audit.verdict) || !validDate(audit.auditedAt)
    || typeof audit.summary !== 'string' || typeof audit.matchScore !== 'number' || !Number.isFinite(audit.matchScore)
    || typeof audit.source !== 'string' || !Array.isArray(audit.findings)) throw new Error('Invalid audit data')
  const bytes = new TextEncoder().encode(JSON.stringify(canonical([audit.verdict, audit.auditedAt, audit.summary, audit.matchScore, audit.source, audit.findings])))
  const result = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(result), value => value.toString(16).padStart(2, '0')).join('')
}

/** Store a confirmed response only while the original attempt still owns the fence. */
export async function confirmAuditFence(storage: Storage | null, userId: string, jobId: string, attemptId: string, audit: AuditFencePost): Promise<boolean> {
  if (!storage) return false
  const initial = readAuditFence(storage, userId, jobId)
  if (initial.state !== 'pending' || initial.fence.attemptId !== attemptId
    || !audit.operationId || !uuid.test(audit.operationId) || !validDate(audit.resumeUpdatedAt)
    || (initial.fence.coverLetterId ? !validDate(audit.coverLetterUpdatedAt) : audit.coverLetterUpdatedAt != null)) return false
  try {
    const digest = await auditDigest(audit)
    const current = readAuditFence(storage, userId, jobId)
    if (current.state !== 'pending' || JSON.stringify(current.fence) !== JSON.stringify(initial.fence)) return false
    const fence: Confirmed = { ...initial.fence, state: 'confirmed', operationId: audit.operationId, resumeUpdatedAt: audit.resumeUpdatedAt,
      coverLetterUpdatedAt: audit.coverLetterUpdatedAt ?? null, digest }
    const raw = JSON.stringify(fence)
    storage.setItem(key(userId, jobId), raw)
    notify()
    return storage.getItem(key(userId, jobId)) === raw
  } catch { notify(); return false }
}

/** Stop waiting after the deadline, but let a late response confirm its own attempt. */
export async function waitForAuditFencePost<T extends { data: AuditFencePost | null; error: string | null }>(
  request: Promise<T>, storage: Storage | null, userId: string, jobId: string, attemptId: string, timeoutMs = 30_000,
): Promise<T | null> {
  const tracked = request.then(async result => {
    if (result.data && !result.error) await confirmAuditFence(storage, userId, jobId, attemptId, result.data)
    return result
  }).catch(() => null)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([tracked, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs) })])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}

/** A single GET cannot clear an unknown POST; a confirmed attempt needs the exact signed result. */
export async function reconcileAuditFence(storage: Storage | null, userId: string, jobId: string, record: StoredApplicationAudit): Promise<boolean> {
  if (!storage) return false
  const initial = readAuditFence(storage, userId, jobId)
  if (initial.state !== 'confirmed') return false
  const fence = initial.fence as Confirmed
  if (!record || record.operationId !== fence.operationId || record.resumeId !== fence.resumeId
    || record.coverLetterId !== fence.coverLetterId || record.resumeUpdatedAt !== fence.resumeUpdatedAt
    || (record.coverLetterUpdatedAt ?? null) !== fence.coverLetterUpdatedAt
    || record.receipt?.version !== 1 || !hash.test(record.receipt.signature)) return false
  try {
    if (await auditDigest(record.audit) !== fence.digest) return false
    const current = readAuditFence(storage, userId, jobId)
    if (current.state !== 'confirmed' || JSON.stringify(current.fence) !== JSON.stringify(fence)) return false
    storage.removeItem(key(userId, jobId))
    notify()
    return storage.getItem(key(userId, jobId)) === null
  } catch { notify(); return false }
}
