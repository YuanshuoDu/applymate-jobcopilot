import { describe, expect, it } from 'vitest'
import { applicationHistoryIndex } from './application-history-position'

describe('application history position', () => {
  it('reads browser indices and detects unsupported or unavailable navigation entries', () => {
    expect(applicationHistoryIndex({ navigation: { currentEntry: { index: 4 } } } as unknown as Window)).toBe(4)
    expect(applicationHistoryIndex({} as Window)).toBeNull()
    expect(applicationHistoryIndex({ navigation: { currentEntry: null } } as unknown as Window)).toBeNull()
    expect(applicationHistoryIndex({ navigation: { currentEntry: { index: -1 } } } as unknown as Window)).toBeNull()
  })
})
