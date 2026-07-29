import { describe, expect, it } from 'vitest'
import { DEFAULT_RECOMMENDATION_FILTERS, displayRecommendationStatus, filterRecommendations, groupRecommendations } from './recommendations-model'
import type { GmailRecommendation } from './types'

const recommendations: GmailRecommendation[] = [
  recommendation('one', 'Indeed', 'Dublin, Ireland', 'Senior Support Engineer', '2026-07-29T08:00:00.000Z'),
  { ...recommendation('two', 'LinkedIn', 'Berlin, Germany', 'Data Engineer', '2026-07-28T08:00:00.000Z'), status: 'saved' },
]

describe('recommendations model', () => {
  it('filters by search, platform, status, and location', () => {
    expect(filterRecommendations(recommendations, { ...DEFAULT_RECOMMENDATION_FILTERS, platform: 'LinkedIn', status: 'all' })).toEqual([recommendations[1]])
    expect(filterRecommendations(recommendations, { ...DEFAULT_RECOMMENDATION_FILTERS, search: 'support' })).toEqual([recommendations[0]])
    expect(filterRecommendations(recommendations, { ...DEFAULT_RECOMMENDATION_FILTERS, location: 'Berlin, Germany', status: 'all' })).toEqual([recommendations[1]])
  })

  it('groups recommendations by the date their source email arrived', () => {
    const groups = groupRecommendations(recommendations, new Date('2026-07-29T12:00:00.000Z'))
    expect(groups.map(group => group.label)).toEqual(['Today — Jul 29', 'Yesterday — Jul 28'])
  })

  it('uses candidate-facing status labels', () => {
    expect(displayRecommendationStatus('pending')).toBe('New')
    expect(displayRecommendationStatus('saved')).toBe('Saved')
    expect(displayRecommendationStatus('dismissed')).toBe('Dismissed')
  })
})

function recommendation(id: string, platform: string, location: string, role: string, receivedAt: string): GmailRecommendation {
  return {
    id, platform, location, role, company: 'Example Co', salary: null, url: null, description: null, status: 'pending', createdAt: receivedAt,
    sourceMessage: { subject: `New roles for you: ${role}`, receivedAt }, savedJob: null,
  }
}
