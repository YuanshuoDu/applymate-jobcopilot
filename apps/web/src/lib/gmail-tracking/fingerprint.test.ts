import { describe, expect, it } from 'vitest'
import { createRecommendationFingerprint } from './fingerprint'

describe('createRecommendationFingerprint', () => {
  it('is deterministic and ignores URL tracking parameters', () => {
    const first = createRecommendationFingerprint({
      platform: 'Indeed', company: 'Acme', role: 'Data Engineer', location: 'Berlin',
      url: 'https://example.com/jobs/42?utm_source=email&b=2',
    })
    const second = createRecommendationFingerprint({
      platform: 'ignored', company: 'different', role: 'different', location: 'different',
      url: 'https://example.com/jobs/42?b=2&utm_campaign=daily',
    })
    expect(first).toBe(second)
  })
})
