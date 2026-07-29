import { describe, expect, it } from 'vitest'
import { isLikelyJobDetailUrl, recommendationIdentityKey, recommendationSemanticKey, simplifyRecommendationLocation } from './recommendation-utils'

describe('recommendation utils', () => {
  it('reduces alert prose to a user-facing location', () => {
    expect(simplifyRecommendationLocation('6 new internship jobs in Dublin, County Dublin')).toBe('Dublin, County Dublin')
    expect(simplifyRecommendationLocation('Remote — Ireland')).toBe('Remote')
  })

  it('uses a stable identity when alert tracking parameters differ', () => {
    const first = recommendationIdentityKey({ platform: 'Indeed', role: 'Data Engineer', company: 'Acme', location: 'Dublin, County Dublin', url: 'https://ie.indeed.com/viewjob?jk=123&utm_source=email' })
    const second = recommendationIdentityKey({ platform: 'Indeed', role: 'Data Engineer', company: 'Acme', location: 'Dublin, County Dublin', url: 'https://ie.indeed.com/viewjob?jk=123&tmtk=another' })
    expect(first).toBe(second)
    expect(isLikelyJobDetailUrl('https://ie.indeed.com/jobs?q=data+engineer')).toBe(false)
  })

  it('groups repeated alerts by their stable job facts even if redirect ids differ', () => {
    const first = recommendationSemanticKey({ platform: 'Indeed', role: 'Intern - AI & ML', company: 'Ascentic', location: null, url: 'https://ie.indeed.com/viewjob?jk=first' })
    const second = recommendationSemanticKey({ platform: 'Indeed', role: 'Intern - AI & ML', company: 'Ascentic', location: null, url: 'https://ie.indeed.com/viewjob?jk=second' })
    expect(first).toBe(second)
  })
})
