import { describe, expect, it } from 'vitest'
import { sanitizeSupportMessage, supportStatusTransition } from './support'

describe('support case safety', () => {
  it('redacts secret-like values before persistence', () => {
    const result = sanitizeSupportMessage('Please check Bearer abcdefghijklmnop1234 and <b>this</b>')
    expect(result.redacted).toBe(true)
    expect(result.text).toContain('[REDACTED]')
    expect(result.text).toContain('this')
  })
  it('allows only forward lifecycle transitions', () => {
    expect(supportStatusTransition('open', 'in_progress')).toBe(true)
    expect(supportStatusTransition('closed', 'open')).toBe(false)
  })
})
