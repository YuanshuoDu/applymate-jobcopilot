import { translate, type Lang } from '@/lib/i18n'

export type ManualRecordStatus = 'pending' | 'unknown' | 'reported'
export type ManualRecordState = 'idle' | ManualRecordStatus

export interface ManualRecordStorageRead {
  available: boolean
  status: ManualRecordStatus | null
}

const STORAGE_PREFIX = 'applymate:manual-application-record:v1:'
const LABEL_KEYS: Record<ManualRecordState, string> = {
  idle: 'agent.manualRecordAction',
  pending: 'agent.manualRecordPending',
  unknown: 'agent.manualRecordUnknown',
  reported: 'agent.manualRecordReported',
}

export function manualRecordLabel(lang: Lang, state: ManualRecordState): string {
  return translate(lang, LABEL_KEYS[state])
}

export function manualRecordStorageKey(userId: string, jobId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(userId)}:${encodeURIComponent(jobId)}`
}

export function readManualRecordStatus(userId: string | null, jobId: string): ManualRecordStorageRead {
  if (!userId || typeof window === 'undefined') return { available: false, status: null }
  try {
    const value = window.localStorage.getItem(manualRecordStorageKey(userId, jobId))
    if (value === null) return { available: true, status: null }
    const status = value === 'pending' || value === 'unknown' || value === 'reported' ? value : 'unknown'
    return { available: true, status }
  } catch {
    return { available: false, status: null }
  }
}

export function writeManualRecordStatus(userId: string | null, jobId: string, status: ManualRecordStatus): boolean {
  if (!userId || typeof window === 'undefined') return false
  try {
    window.localStorage.setItem(manualRecordStorageKey(userId, jobId), status)
    return true
  } catch {
    return false
  }
}

interface ApplyJobActionsOptions {
  jobId: string
  jobUrl: string | null
  onApplied: (id: string) => void | Promise<void>
  openWindow: (url: string, target: string, features: string) => unknown
  isCurrentScope: () => boolean
  getRecordState: () => ManualRecordState
  setRecordState: (state: ManualRecordState) => void
  readPersistedStatus: () => ManualRecordStorageRead
  writePersistedStatus: (status: ManualRecordStatus) => boolean
}

/** Employer navigation and recording a user's completed submission stay separate. */
export function createApplyJobActions({
  jobId, jobUrl, onApplied, openWindow, isCurrentScope, getRecordState, setRecordState,
  readPersistedStatus, writePersistedStatus,
}: ApplyJobActionsOptions) {
  return {
    openEmployer() {
      if (jobUrl) openWindow(jobUrl, '_blank', 'noopener')
    },
    async recordSubmitted() {
      if (!isCurrentScope()) return
      if (getRecordState() !== 'idle') return

      const persisted = readPersistedStatus()
      if (!persisted.available) {
        if (isCurrentScope()) setRecordState('unknown')
        return
      }
      if (persisted.status) {
        if (isCurrentScope()) setRecordState(persisted.status)
        return
      }

      // Persist the in-flight fence before the POST so a reload cannot repeat
      // an outcome whose response may be lost.
      if (!writePersistedStatus('pending')) {
        if (isCurrentScope()) setRecordState('unknown')
        return
      }
      if (isCurrentScope()) setRecordState('pending')
      try {
        await onApplied(jobId)
        writePersistedStatus('reported')
        if (isCurrentScope()) setRecordState('reported')
      } catch {
        writePersistedStatus('unknown')
        if (isCurrentScope()) setRecordState('unknown')
      }
    },
  }
}
