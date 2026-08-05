import { describe, expect, it } from 'vitest'
import { userScopedStorageKey } from './user-scoped-storage'

describe('userScopedStorageKey', () => {
  it('keeps the same cache namespace isolated per authenticated user', () => {
    expect(userScopedStorageKey('applymate:gmail-inbox', 'user-a')).toBe('applymate:gmail-inbox:user-a')
    expect(userScopedStorageKey('applymate:gmail-inbox', 'user-b')).toBe('applymate:gmail-inbox:user-b')
  })

  it('does not create a shared key for an anonymous session', () => {
    expect(userScopedStorageKey('applymate:gmail-inbox', null)).toBeNull()
    expect(userScopedStorageKey('applymate:gmail-inbox', '')).toBeNull()
  })
})
