import { describe, expect, it, vi } from 'vitest'
import {
  createApplyJobActions,
  manualRecordStorageKey,
  readManualRecordStatus,
  writeManualRecordStatus,
  type ManualRecordState,
  type ManualRecordStatus,
} from './apply-job-actions'

const jobId = 'job-1'
const jobUrl = 'https://example.com/apply'

function actionHarness(options: {
  state?: ManualRecordState
  persisted?: ManualRecordStatus | null
  storageReadAvailable?: boolean
  storageWriteAvailable?: boolean
  isCurrentScope?: () => boolean
  onApplied?: (id: string) => void | Promise<void>
} = {}) {
  let state: ManualRecordState = options.state ?? 'idle'
  let persisted = options.persisted ?? null
  const stateChanges: ManualRecordState[] = []
  const writes: ManualRecordStatus[] = []
  const openWindow = vi.fn(() => null)
  const onApplied = vi.fn(options.onApplied ?? (() => undefined))
  const actions = createApplyJobActions({
    jobId,
    jobUrl,
    onApplied,
    openWindow,
    isCurrentScope: options.isCurrentScope ?? (() => true),
    getRecordState: () => state,
    setRecordState: next => {
      state = next
      stateChanges.push(next)
    },
    readPersistedStatus: () => ({
      available: options.storageReadAvailable !== false,
      status: persisted,
    }),
    writePersistedStatus: next => {
      if (options.storageWriteAvailable === false) return false
      persisted = next
      writes.push(next)
      return true
    },
  })
  return { actions, onApplied, openWindow, stateChanges, writes, getState: () => state, getPersisted: () => persisted }
}

describe('Agent employer-page and manual-record actions', () => {
  it('keeps employer navigation open-only when the popup is blocked', () => {
    const { actions, onApplied, openWindow } = actionHarness()

    actions.openEmployer()

    expect(openWindow).toHaveBeenCalledWith(jobUrl, '_blank', 'noopener')
    expect(onApplied).not.toHaveBeenCalled()
  })

  it('records only after explicit confirmation and persists pending before the request', async () => {
    let resolveRequest!: () => void
    const request = new Promise<void>(resolve => { resolveRequest = resolve })
    const harness = actionHarness({ onApplied: () => request })

    const result = harness.actions.recordSubmitted()
    expect(harness.getPersisted()).toBe('pending')
    expect(harness.getState()).toBe('pending')
    expect(harness.onApplied).toHaveBeenCalledOnce()
    expect(harness.openWindow).not.toHaveBeenCalled()
    await harness.actions.recordSubmitted()
    expect(harness.onApplied).toHaveBeenCalledOnce()

    resolveRequest()
    await result
    expect(harness.getPersisted()).toBe('reported')
    expect(harness.getState()).toBe('reported')
  })

  it('does not retry in-flight or unknown outcomes restored after reload', async () => {
    for (const status of ['pending', 'unknown'] as const) {
      const harness = actionHarness({ persisted: status })
      await harness.actions.recordSubmitted()

      expect(harness.onApplied, status).not.toHaveBeenCalled()
      expect(harness.getState(), status).toBe(status)
      expect(harness.writes, status).toEqual([])
    }
  })

  it('keeps failed request outcomes unknown and fences later clicks', async () => {
    const harness = actionHarness({ onApplied: () => Promise.reject(new Error('Network error')) })

    await harness.actions.recordSubmitted()
    await harness.actions.recordSubmitted()

    expect(harness.onApplied).toHaveBeenCalledOnce()
    expect(harness.writes).toEqual(['pending', 'unknown'])
    expect(harness.getState()).toBe('unknown')
  })

  it('fails closed when storage cannot be read or written', async () => {
    for (const options of [{ storageReadAvailable: false }, { storageWriteAvailable: false }]) {
      const harness = actionHarness(options)
      await harness.actions.recordSubmitted()

      expect(harness.onApplied).not.toHaveBeenCalled()
      expect(harness.getState()).toBe('unknown')
    }
  })

  it('keeps a late A result in A storage and out of B state across A→B→A', async () => {
    let activeUser = 'user-a'
    let resolveA!: () => void
    let resolveB!: () => void
    const requestA = new Promise<void>(resolve => { resolveA = resolve })
    const requestB = new Promise<void>(resolve => { resolveB = resolve })
    const accountA = actionHarness({
      isCurrentScope: () => activeUser === 'user-a',
      onApplied: () => requestA,
    })
    const resultA = accountA.actions.recordSubmitted()

    activeUser = 'user-b'
    const accountB = actionHarness({
      isCurrentScope: () => activeUser === 'user-b',
      onApplied: () => requestB,
    })
    const resultB = accountB.actions.recordSubmitted()

    resolveA()
    await resultA
    expect(accountA.getPersisted()).toBe('reported')
    expect(accountA.getState()).toBe('pending')
    expect(accountB.getPersisted()).toBe('pending')
    expect(accountB.getState()).toBe('pending')

    resolveB()
    await resultB
    expect(accountB.getPersisted()).toBe('reported')
    expect(accountB.getState()).toBe('reported')

    activeUser = 'user-a'
    const restoredA = actionHarness({ state: 'reported', persisted: 'reported' })
    await restoredA.actions.recordSubmitted()
    expect(restoredA.onApplied).not.toHaveBeenCalled()
  })

  it('scopes persisted statuses to the authenticated user and job', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value) },
      },
    })

    try {
      expect(writeManualRecordStatus('user-1', jobId, 'pending')).toBe(true)
      expect(readManualRecordStatus('user-1', jobId)).toEqual({ available: true, status: 'pending' })
      expect(readManualRecordStatus('user-2', jobId)).toEqual({ available: true, status: null })
      expect(readManualRecordStatus('user-1', 'job-2')).toEqual({ available: true, status: null })
      expect(manualRecordStorageKey('user-1', jobId)).not.toBe(manualRecordStorageKey('user-2', jobId))
      expect(writeManualRecordStatus('user-1', jobId, 'unknown')).toBe(true)
      expect(readManualRecordStatus('user-1', jobId)).toEqual({ available: true, status: 'unknown' })
      values.set(manualRecordStorageKey('user-1', 'job-corrupt'), 'unexpected')
      expect(readManualRecordStatus('user-1', 'job-corrupt')).toEqual({ available: true, status: 'unknown' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('treats unavailable storage as a failed read', () => {
    vi.stubGlobal('window', {
      localStorage: { getItem: () => { throw new Error('Storage blocked') } },
    })
    try {
      expect(readManualRecordStatus('user-1', jobId)).toEqual({ available: false, status: null })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
