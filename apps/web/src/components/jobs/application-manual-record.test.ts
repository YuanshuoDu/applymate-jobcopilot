import { describe, expect, it } from 'vitest'
import { clearManualRecordLock, readManualRecordLock, writeManualRecordLock } from './application-manual-record'

function memoryStorage(): Storage {
  const entries = new Map<string, string>()
  return { get length() { return entries.size }, clear: () => entries.clear(), key: i => [...entries.keys()][i] ?? null,
    getItem: key => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, value) }, removeItem: key => { entries.delete(key) } }
}

describe('manual record lock', () => {
  it('survives reopening and isolates account and job identities', () => {
    const store = memoryStorage()
    expect(writeManualRecordLock(store, 'a:b', 'job/1', 'pending')).toBe(true)
    expect(readManualRecordLock(store, 'a:b', 'job/1')).toBe('pending')
    expect(readManualRecordLock(store, 'a', 'b:job/1')).toBeNull()
    expect(readManualRecordLock(store, 'a:b', 'job/2')).toBeNull()
    writeManualRecordLock(store, 'a:b', 'job/1', 'confirmed')
    expect(readManualRecordLock(store, 'a:b', 'job/1')).toBe('confirmed')
    clearManualRecordLock(store, 'a:b', 'job/1')
    expect(readManualRecordLock(store, 'a:b', 'job/1')).toBeNull()
  })
  it('fails closed on inaccessible or malformed storage', () => {
    const unavailable = { getItem: () => { throw Error('denied') }, setItem: () => { throw Error('denied') } } as unknown as Storage
    expect(readManualRecordLock(unavailable, 'a', 'j')).toBe('unknown')
    expect(writeManualRecordLock(unavailable, 'a', 'j', 'pending')).toBe(false)
    const malformed = memoryStorage()
    malformed.setItem('applymate:manual-record:a:j', 'unrecognized')
    expect(readManualRecordLock(malformed, 'a', 'j')).toBe('unknown')
  })
})
