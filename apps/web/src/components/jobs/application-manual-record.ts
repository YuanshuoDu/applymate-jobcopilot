export type ManualRecordLock = 'pending' | 'confirmed' | 'unknown'

function key(userId: string, jobId: string): string {
  return `applymate:manual-record:${encodeURIComponent(userId)}:${encodeURIComponent(jobId)}`
}

/** Only account, job and outcome are stored; no application content is retained. */
export function readManualRecordLock(storage: Storage, userId: string, jobId: string): ManualRecordLock | null {
  try {
    const value = storage.getItem(key(userId, jobId))
    if (value === 'pending' || value === 'confirmed' || value === 'unknown') return value
    // Unexpected persisted state cannot prove that a previous write was absent.
    return value === null ? null : 'unknown'
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

export function clearManualRecordLock(storage: Storage, userId: string, jobId: string): void {
  try { storage.removeItem(key(userId, jobId)) } catch { /* keep a conservative lock on storage failure */ }
}
