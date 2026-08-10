import { describe, expect, it } from 'vitest'
import { formatPlanMoney, groupPlanEntitlements } from './PlansPage'

describe('admin plan view model', () => {
  it('formats EUR cents and groups entitlements by kind', () => {
    expect(formatPlanMoney(1900, 'EUR')).toBe('€19.00')
    expect(groupPlanEntitlements([{ featureKey: 'auto_apply', kind: 'boolean' }, { featureKey: 'ai_credits', kind: 'limit' }])).toEqual({ boolean: ['auto_apply'], limit: ['ai_credits'], text: [] })
  })
})
