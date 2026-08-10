import { describe, expect, it } from 'vitest'
import { broadcastActionLabel, audienceLabel } from './BroadcastsPage'

describe('admin broadcast view model', () => {
  it('labels audience selectors without recipient PII', () => {
    expect(audienceLabel({ audienceType: 'plan', audience: { plan: 'pro' } })).toBe('Pro plan')
    expect(audienceLabel({ audienceType: 'explicit_user_ids', audience: { userIds: ['u1', 'u2'] } })).toBe('2 selected accounts')
  })
  it('exposes only lifecycle actions', () => {
    expect(broadcastActionLabel('draft')).toBe('Submit for approval')
    expect(broadcastActionLabel('scheduled')).toBe('Publish')
  })
})
