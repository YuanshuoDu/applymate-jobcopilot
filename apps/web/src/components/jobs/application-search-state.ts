import { userScopedStorageKey } from '@/lib/user-scoped-storage'

const SAVED_RESULTS_KEY = 'applymate:saved-search-applications'
const MAX_SAVED_RESULTS = 300

type SearchResultIdentity = { id: string; source: string; url: string }
type SavedApplications = Record<string, string>
type ReadStorage = Pick<Storage, 'getItem'>
type WriteStorage = Pick<Storage, 'setItem'>

export function searchResultKey(result: SearchResultIdentity): string {
  return JSON.stringify([result.source, result.id, result.url])
}

export function readSavedApplications(storage: ReadStorage, userId: string | null): SavedApplications {
  const key = userScopedStorageKey(SAVED_RESULTS_KEY, userId)
  if (!key) return {}
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0)
      .slice(-MAX_SAVED_RESULTS))
  } catch { return {} }
}

export function writeSavedApplications(storage: WriteStorage, userId: string | null, saved: SavedApplications): void {
  const key = userScopedStorageKey(SAVED_RESULTS_KEY, userId)
  if (!key) return
  try { storage.setItem(key, JSON.stringify(Object.fromEntries(Object.entries(saved).slice(-MAX_SAVED_RESULTS)))) } catch { /* Navigation still works when storage is unavailable. */ }
}

/** Call only after a confirmed deletion, never for a transient navigation/read failure. */
export function forgetSavedApplication(userId: string | null, jobId: string): void {
  if (!userId || !jobId || typeof window === 'undefined') return
  try {
    const saved = readSavedApplications(window.sessionStorage, userId)
    writeSavedApplications(window.sessionStorage, userId,
      Object.fromEntries(Object.entries(saved).filter(([, id]) => id !== jobId)))
    window.dispatchEvent(new Event('applymate:saved-search-changed'))
  } catch { /* Storage is optional. */ }
}

/** Guard synchronous repeated clicks before React has rendered the saving state. */
export function createApplicationSaveGuard() {
  const pending = new Set<string>()
  return {
    acquire(key: string): boolean {
      if (pending.has(key)) return false
      pending.add(key)
      return true
    },
    release(key: string) { pending.delete(key) },
  }
}
