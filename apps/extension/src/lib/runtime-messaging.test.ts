import { describe, expect, it } from 'vitest'
import { isExtensionContextInvalidated } from './runtime-messaging'

describe('runtime messaging', () => {
  it('recognizes an invalidated extension context', () => {
    expect(isExtensionContextInvalidated(new Error('Extension context invalidated.'))).toBe(true)
    expect(isExtensionContextInvalidated(new Error('The message port closed.'))).toBe(false)
  })
})

