import { describe, expect, it } from 'vitest'
import { sanitizeBroadcastText, validateBroadcastAudience, validateBroadcastStatus } from './broadcast'

describe('admin broadcast controls', () => {
  it('sanitizes HTML and secret-like content', () => {
    const result = sanitizeBroadcastText('<b>Service update</b> sk-test-12345678901234567890')
    expect(result.text).toContain('Service update')
    expect(result.text).toContain('[REDACTED]')
    expect(result.redacted).toBe(true)
  })
  it('accepts only approved audience selectors', () => {
    expect(validateBroadcastAudience({ audienceType: 'plan', plan: 'pro' })).toEqual({ audienceType: 'plan', audience: { plan: 'pro' } })
    expect(() => validateBroadcastAudience({ audienceType: 'email', value: 'candidate@example.com' })).toThrow()
  })
  it('enforces the draft approval lifecycle', () => {
    expect(validateBroadcastStatus('draft', 'pending_approval')).toBe(true)
    expect(validateBroadcastStatus('draft', 'published')).toBe(false)
  })
})
