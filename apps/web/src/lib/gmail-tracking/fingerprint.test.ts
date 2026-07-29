import { describe, expect, it } from 'vitest'
import { createRecommendationFingerprint } from './fingerprint'

describe('createRecommendationFingerprint', () => {
  it('is deterministic and ignores URL tracking parameters', () => {
    const first = createRecommendationFingerprint({
      platform: 'Indeed', company: 'Acme', role: 'Data Engineer', location: 'Berlin',
      url: 'https://ie.indeed.com/viewjob?jk=42&utm_source=email',
    })
    const second = createRecommendationFingerprint({
      platform: 'Indeed', company: 'Acme', role: 'Data Engineer', location: 'Berlin',
      url: 'https://ie.indeed.com/viewjob?vjk=42&utm_campaign=daily',
    })
    expect(first).toBe(second)
  })
})
