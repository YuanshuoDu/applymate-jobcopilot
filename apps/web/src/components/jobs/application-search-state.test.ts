import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApplicationSaveGuard, forgetSavedApplication, readSavedApplications, searchResultKey, writeSavedApplications } from './application-search-state'

afterEach(() => vi.unstubAllGlobals())

describe('saved Discover applications', () => {
  it('retains the saved database job across page navigation without sharing it with another account', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    }
    const resultKey = searchResultKey({ id: '42', source: 'lever', url: 'https://jobs.lever.co/acme/42' })
    writeSavedApplications(storage, 'candidate-1', { [resultKey]: 'saved-job-17' })
    expect(readSavedApplications(storage, 'candidate-1')[resultKey]).toBe('saved-job-17')
    expect(readSavedApplications(storage, 'candidate-2')).toEqual({})
    expect(readSavedApplications(storage, null)).toEqual({})
  })

  it('keeps source IDs and changed destinations distinct', () => {
    const job = { id: '42', source: 'lever', url: 'https://jobs.example/42' }
    expect(searchResultKey(job)).not.toBe(searchResultKey({ ...job, source: 'greenhouse' }))
    expect(searchResultKey(job)).not.toBe(searchResultKey({ ...job, url: 'https://jobs.example/43' }))
  })

  it('rejects simultaneous duplicate saves and allows an explicit retry after failure', () => {
    const guard = createApplicationSaveGuard()
    expect(guard.acquire('job-a')).toBe(true)
    expect(guard.acquire('job-a')).toBe(false)
    expect(guard.acquire('job-b')).toBe(true)
    guard.release('job-a')
    expect(guard.acquire('job-a')).toBe(true)
  })

  it('tolerates unavailable or corrupt storage and never writes unscoped job IDs', () => {
    const setItem = vi.fn()
    writeSavedApplications({ setItem }, null, { result: 'private-job' })
    expect(setItem).not.toHaveBeenCalled()
    expect(readSavedApplications({ getItem: () => '{bad' }, 'candidate')).toEqual({})
    expect(readSavedApplications({ getItem: () => '{"valid":"job-1","bad":17,"empty":""}' }, 'candidate')).toEqual({ valid: 'job-1' })
    expect(() => writeSavedApplications({ setItem: () => { throw new Error('blocked') } }, 'candidate', {})).not.toThrow()
  })

  it('forgets only explicitly deleted jobs for the current account, allowing the result to be saved again', () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    const dispatchEvent = vi.fn()
    vi.stubGlobal('window', { sessionStorage: storage, dispatchEvent })
    writeSavedApplications(storage, 'candidate-a', { first: 'job-deleted', second: 'job-kept', alias: 'job-deleted' })
    writeSavedApplications(storage, 'candidate-b', { first: 'job-deleted' })
    forgetSavedApplication('candidate-a', 'job-deleted')
    expect(readSavedApplications(storage, 'candidate-a')).toEqual({ second: 'job-kept' })
    expect(readSavedApplications(storage, 'candidate-b')).toEqual({ first: 'job-deleted' })
    expect(dispatchEvent.mock.calls[0][0].type).toBe('applymate:saved-search-changed')
  })
})
