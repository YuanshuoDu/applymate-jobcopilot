import { describe, expect, it } from 'vitest'
import { hardRpsLimit, parseAtsEmployerRegistration, parseAtsEmployerUpdate, parseAtsPolicy } from './ats-service'

describe('ATS policy validation', () => {
  it('keeps rate settings within an explicit shape and exposes hard ceilings', () => {
    expect(hardRpsLimit('workday')).toBe(1)
    expect(parseAtsPolicy({ rolloutPercent: 100, globalRpsLimit: 1, perTenantRpsLimit: 1, maxRetries: 3, backoffBaseMs: 1000, allowAutoApply: false, version: 1 })).toMatchObject({ globalRpsLimit: 1 })
    expect(parseAtsPolicy({ rolloutPercent: 101, globalRpsLimit: 1, perTenantRpsLimit: 1, maxRetries: 3, backoffBaseMs: 1000, allowAutoApply: false, version: 1 })).toBeNull()
  })

  it('preserves case-sensitive slugs and validates managed registry fields', () => {
    expect(parseAtsEmployerRegistration({ atsType: 'LEVER', slug: 'tradeRepublic', name: 'Trade Republic', country: 'DE', enabled: true })).toEqual({
      atsType: 'lever', slug: 'tradeRepublic', name: 'Trade Republic', country: 'de', enabled: true,
    })
    expect(parseAtsEmployerRegistration({ atsType: 'personio', slug: 'example', name: 'Example' })).toBeNull()
    expect(parseAtsEmployerRegistration({ atsType: 'lever', slug: 'bad slug', name: 'Example' })).toBeNull()
  })

  it('requires an optimistic version for registry updates', () => {
    expect(parseAtsEmployerUpdate({ name: 'New name', country: '', enabled: false, version: 2 })).toEqual({ name: 'New name', country: null, enabled: false, version: 2 })
    expect(parseAtsEmployerUpdate({ name: 'New name', enabled: false, version: 0 })).toBeNull()
    expect(parseAtsEmployerUpdate({ name: 'New name', version: 2 })).toBeNull()
  })
})
