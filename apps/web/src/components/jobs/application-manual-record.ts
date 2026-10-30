import { JOB_STATUSES, type Job } from '@/lib/types'

export type ManualRecordLock = 'pending' | 'confirmed' | 'unknown' | 'rejected-limit' | 'rejected-plan'

type ManualRecordEvidence = Pick<Job, 'status' | 'workflowState' | 'appliedAt'>

/** A user-reported or system-recorded application, not an employer receipt. */
export function hasVisibleSubmissionRecord(job: ManualRecordEvidence): boolean {
  return job.status === 'applied' || (typeof job.appliedAt === 'string'
    && job.appliedAt.trim().length > 0 && Number.isFinite(Date.parse(job.appliedAt)))
}

/** Preserve the duplicate guard when historical status or timestamp is uncertain. */
export function blocksManualRecord(job: ManualRecordEvidence): boolean {
  return job.status !== 'saved' || !['draft', 'ready_to_apply'].includes(job.workflowState) || job.appliedAt !== null
}

function key(userId: string, jobId: string): string {
  return `applymate:manual-record:${encodeURIComponent(userId)}:${encodeURIComponent(jobId)}`
}

/** Only account, job and outcome are stored; no application content is retained. */
export function readManualRecordLock(storage: Storage, userId: string, jobId: string): ManualRecordLock | null {
  try {
    const value = storage.getItem(key(userId, jobId))
    if (value === 'pending' || value === 'confirmed' || value === 'unknown' || value === 'rejected-limit' || value === 'rejected-plan') return value
    // Unexpected persisted state cannot prove that a previous write was absent.
    return value === null ? null : 'unknown'
  } catch { return 'unknown' }
}

/** Only a verified rejection of the currently pending request can release it. */
export function rejectPendingManualRecord(storage: Storage, userId: string, jobId: string, reason: 'limit' | 'plan'): boolean {
  if (!userId || !jobId) return false
  try {
    const recordKey = key(userId, jobId)
    if (storage.getItem(recordKey) !== 'pending') return false
    storage.setItem(recordKey, `rejected-${reason}`)
    return storage.getItem(recordKey) === `rejected-${reason}`
  } catch { return false }
}

export type ManualRecordOutcome = 'confirmed' | 'unknown' | 'limit' | 'plan'

/** Bound both the response and body read, even if a fetch mock ignores abort. */
async function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>, fallback: T): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<T>(resolve => {
    timer = setTimeout(() => { resolve(fallback); controller.abort() }, 15_000)
  })
  try {
    return await Promise.race([Promise.resolve().then(() => run(controller.signal)).catch(() => fallback), deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** A rejection is definitive only when the endpoint echoes this request's ID. */
export async function submitManualRecord(jobId: string, requestId: string): Promise<ManualRecordOutcome> {
  return withDeadline<ManualRecordOutcome>(async signal => {
    const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestId, 'X-Manual-Record-Request-Id': requestId },
      body: '{}',
      signal,
    })
    const body: unknown = await response.json()
    if (!body || typeof body !== 'object') return 'unknown'
    const result = body as { applied?: unknown; code?: unknown; requestId?: unknown }
    if (response.ok && result.applied === true) return 'confirmed'
    if (response.status === 403 && result.requestId === requestId) {
      if (result.code === 'MANUAL_APPLICATION_LIMIT_REACHED') return 'limit'
      if (result.code === 'MANUAL_APPLICATION_PLAN_RESTRICTED') return 'plan'
    }
    return 'unknown'
  }, 'unknown')
}

/** A failed read does not determine whether a prior write happened. */
export async function readManualRecord(jobId: string): Promise<unknown | null> {
  return withDeadline<unknown | null>(async signal => {
    const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { signal, cache: 'no-store' })
    if (!response.ok) return null
    return await response.json() as unknown
  }, null)
}

/** Validate the complete scoped row before replacing the current application. */
export function parseScopedManualRecordJob(value: unknown, userId: string, jobId: string): Job | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !userId || !jobId) return null
  const row = value as Record<string, unknown>
  if (row.id !== jobId || row.userId !== userId || typeof row.company !== 'string' || typeof row.role !== 'string') return null
  if (typeof row.status !== 'string' || !JOB_STATUSES.includes(row.status as Job['status'])) return null
  if (typeof row.workflowState !== 'string' || !['draft', 'ready_to_apply', 'queued', 'submitting', 'submitted'].includes(row.workflowState)) return null
  if (row.score !== null && (typeof row.score !== 'number' || !Number.isFinite(row.score))) return null
  const nullableStrings = ['logo', 'location', 'url', 'description', 'salary', 'source', 'notes', 'coverLetter', 'analysisNote', 'keywords', 'finalResumeId', 'finalCoverLetterId']
  if (nullableStrings.some(key => row[key] !== null && typeof row[key] !== 'string')) return null
  const isDate = (date: unknown) => typeof date === 'string' && date.trim().length > 0 && Number.isFinite(Date.parse(date))
  if (!isDate(row.createdAt) || !isDate(row.updatedAt)) return null
  if ((row.appliedAt !== null && !isDate(row.appliedAt)) || (row.followUpAt !== null && !isDate(row.followUpAt))) return null
  return row as unknown as Job
}

/** Returns false when the lock cannot survive a tab reload; callers must not POST. */
export function writeManualRecordLock(storage: Storage, userId: string, jobId: string, state: ManualRecordLock): boolean {
  if (!userId || !jobId) return false
  try {
    storage.setItem(key(userId, jobId), state)
    return storage.getItem(key(userId, jobId)) === state
  } catch { return false }
}
