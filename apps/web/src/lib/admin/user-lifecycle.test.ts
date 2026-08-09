import { describe, expect, it } from 'vitest'
import { parseAccountState, parseFeatureOverride, parsePlan, reasonFrom } from './user-lifecycle'

describe('admin user lifecycle validation', () => {
  it('accepts bounded account and plan changes', () => {
    expect(parseAccountState('suspended')).toBe('suspended')
    expect(parsePlan('enterprise')).toBe('enterprise')
    expect(reasonFrom('  Suspend after a verified abuse report  ')).toBe('Suspend after a verified abuse report')
  })

  it('rejects unsafe overrides and weak reasons', () => {
    expect(parseFeatureOverride({ featureKey: 'bad key', enabled: true })).toMatchObject({ error: expect.any(String) })
    expect(parseFeatureOverride({ featureKey: 'auto_apply', enabled: true, limit: 1_000_001 })).toMatchObject({ error: expect.any(String) })
    expect(reasonFrom('too short')).toMatchObject({ error: expect.any(String) })
  })
})
