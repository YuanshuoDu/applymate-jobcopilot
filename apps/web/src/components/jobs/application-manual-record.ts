import type { Job } from '@/lib/types'

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

/** A rejection is definitive only when the endpoint echoes this request's ID. */
export async function submitManualRecord(jobId: string, requestId: string): Promise<ManualRecordOutcome> {
  try {
    const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestId, 'X-Manual-Record-Request-Id': requestId },
      body: '{}',
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
  } catch { return 'unknown' }
}

/** Returns false when the lock cannot survive a tab reload; callers must not POST. */
export function writeManualRecordLock(storage: Storage, userId: string, jobId: string, state: ManualRecordLock): boolean {
  if (!userId || !jobId) return false
  try {
    storage.setItem(key(userId, jobId), state)
    return storage.getItem(key(userId, jobId)) === state
  } catch { return false }
}
