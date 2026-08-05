import { describe, expect, it } from 'vitest'
import { parseFeatureFlag } from './feature-flags'

describe('parseFeatureFlag', () => {
  it('requires a future rollback for high-risk production controls', () => {
    expect(parseFeatureFlag({ key: 'auto_apply_enabled', environment: 'production', enabled: true, rolloutPercent: 10, targetPlans: [], targetUserIds: [] })).toBeNull()
    expect(parseFeatureFlag({ key: 'auto_apply_enabled', environment: 'production', enabled: true, rolloutPercent: 10, targetPlans: ['pro'], targetUserIds: [], rollbackAt: '2099-01-01T00:00:00.000Z' })).toEqual(expect.objectContaining({ environment: 'production', targetPlans: ['pro'] }))
  })
})
