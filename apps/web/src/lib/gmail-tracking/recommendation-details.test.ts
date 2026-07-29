import { describe, expect, it } from 'vitest'
import { matchingCard } from './recommendation-details'

describe('matchingCard', () => {
  it('uses the role to select the corresponding job from a source email', () => {
    const card = matchingCard({ platform: 'Indeed', company: null, role: 'Data Engineer', location: null, salary: null, url: null, description: null }, [
      { platform: 'Indeed', company: 'Acme', role: 'Senior Support Engineer', location: 'Dublin', salary: null, url: 'https://example.com/support', description: 'Support description long enough for review.', fingerprint: 'support' },
      { platform: 'Indeed', company: 'Northstar', role: 'Data Engineer', location: 'Dublin, County Dublin', salary: null, url: 'https://example.com/data', description: 'Data role description long enough for review.', fingerprint: 'data' },
    ])

    expect(card).toMatchObject({ company: 'Northstar', role: 'Data Engineer', url: 'https://example.com/data' })
  })
})
