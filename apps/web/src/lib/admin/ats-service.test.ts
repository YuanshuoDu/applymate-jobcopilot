import { describe, expect, it } from 'vitest'
import { hardRpsLimit, parseAtsPolicy } from './ats-service'

describe('ATS policy validation', () => {
  it('keeps rate settings within an explicit shape and exposes hard ceilings', () => {
    expect(hardRpsLimit('workday')).toBe(1)
    expect(parseAtsPolicy({ rolloutPercent: 100, globalRpsLimit: 1, perTenantRpsLimit: 1, maxRetries: 3, backoffBaseMs: 1000, allowAutoApply: false, version: 1 })).toMatchObject({ globalRpsLimit: 1 })
    expect(parseAtsPolicy({ rolloutPercent: 101, globalRpsLimit: 1, perTenantRpsLimit: 1, maxRetries: 3, backoffBaseMs: 1000, allowAutoApply: false, version: 1 })).toBeNull()
  })
})
