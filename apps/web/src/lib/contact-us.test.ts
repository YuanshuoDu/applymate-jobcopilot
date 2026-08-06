import { describe, expect, it } from 'vitest'
import { getSlaDueAt, parseNewCase, sanitizeSupportText } from './contact-us'

describe('sanitizeSupportText', () => {
  it('strips markup and redacts token-like content before storage', () => {
    expect(sanitizeSupportText('<b>Help</b> api_key=sk_12345678901234567890')).toEqual({ body: 'Help [REDACTED]', redacted: true })
  })

  it('rejects empty and oversized messages', () => {
    expect(sanitizeSupportText('')).toBeNull()
    expect(sanitizeSupportText('a'.repeat(5001))).toBeNull()
  })
})

describe('support case input', () => {
  it('allows only approved categories and calculates SLA from server time', () => {
    expect(parseNewCase({ subject: 'Sync issue', category: 'technical', message: 'My application sync stopped.' })).toEqual(expect.objectContaining({ category: 'technical' }))
    expect(parseNewCase({ subject: 'Sync issue', category: 'mailbox', message: 'My application sync stopped.' })).toBeNull()
    const now = new Date('2026-08-05T10:00:00.000Z')
    expect(getSlaDueAt('technical', 'normal', now).toISOString()).toBe('2026-08-05T22:00:00.000Z')
  })
})
