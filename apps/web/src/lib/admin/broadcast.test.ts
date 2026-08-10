import { describe, expect, it } from 'vitest'
import { serializeBroadcast, storedAudience, sanitizeBroadcastText, validateBroadcastAudience, validateBroadcastStatus } from './broadcast'

describe('admin broadcast controls', () => {
  it('serializes broadcast timestamps and revalidates stored audience JSON', () => {
    const value = serializeBroadcast({ id: 'broadcast-1', title: 'Update', body: 'Text', audienceType: 'all_active_users', audience: {}, status: 'draft', scheduledAt: null, createdById: 'admin-1', approvedById: null, publishedById: null, recipientCount: 0, deliveredCount: 0, failedCount: 0, createdAt: new Date('2026-08-06T00:00:00Z'), updatedAt: new Date('2026-08-06T01:00:00Z') })
    expect(value.createdAt).toBe('2026-08-06T00:00:00.000Z')
    expect(storedAudience({ audienceType: 'plan', audience: { plan: 'pro' } })).toEqual({ audienceType: 'plan', audience: { plan: 'pro' } })
  })

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
