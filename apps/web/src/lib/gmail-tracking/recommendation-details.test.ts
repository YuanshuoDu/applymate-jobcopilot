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

  it('uses the stored job URL instead of a duplicate role in the same email', () => {
    const card = matchingCard({ platform: 'Indeed', company: 'Wrong company', role: 'Data Engineer', location: null, salary: null, url: 'https://ie.indeed.com/viewjob?jk=right', description: null }, [
      { platform: 'Indeed', company: 'First Co', role: 'Data Engineer', location: 'Dublin', salary: null, url: 'https://ie.indeed.com/viewjob?jk=wrong', description: 'First description.', fingerprint: 'wrong' },
      { platform: 'Indeed', company: 'Right Co', role: 'Data Engineer', location: 'Cork', salary: null, url: 'https://ie.indeed.com/viewjob?jk=right', description: 'Correct description.', fingerprint: 'right' },
    ])

    expect(card).toMatchObject({ company: 'Right Co', location: 'Cork', url: 'https://ie.indeed.com/viewjob?jk=right' })
  })

  it('does not select an arbitrary job when duplicate roles have no stable match', () => {
    const card = matchingCard({ platform: 'Indeed', company: null, role: 'Data Engineer', location: null, salary: null, url: null, description: null }, [
      { platform: 'Indeed', company: 'First Co', role: 'Data Engineer', location: 'Dublin', salary: null, url: 'https://example.com/one', description: 'First description.', fingerprint: 'one' },
      { platform: 'Indeed', company: 'Second Co', role: 'Data Engineer', location: 'Cork', salary: null, url: 'https://example.com/two', description: 'Second description.', fingerprint: 'two' },
    ])

    expect(card).toBeNull()
  })
})
