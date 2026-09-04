import { describe, expect, it } from 'vitest'
import { audienceWhere, parseBroadcastInput, storedAudience } from './broadcast-service'

describe('broadcast audience validation', () => {
  it('allows only the approved audience selectors', () => {
    expect(parseBroadcastInput({ title: 'Service update', body: 'Brief maintenance notice.', audienceType: 'plan', audience: { plan: 'pro' } })).toEqual(expect.objectContaining({ audience: { type: 'plan', value: { plan: 'pro' } } }))
    expect(parseBroadcastInput({ title: 'Bad selector', body: 'Never target private job content.', audienceType: 'job_text', audience: {} })).toBeNull()
    expect(storedAudience({ userIds: ['u1', 'u1'] }, 'explicit_user_ids')).toEqual({ type: 'explicit_user_ids', value: { userIds: ['u1'] } })
    expect(audienceWhere({ type: 'location', value: { location: 'Berlin' } })).toEqual({ accountStatus: 'active', location: 'Berlin' })
    expect(audienceWhere({ type: 'all_active_users', value: {} })).toEqual({ accountStatus: 'active' })
  })
})
