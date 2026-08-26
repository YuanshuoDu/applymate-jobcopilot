import { describe, expect, it } from 'vitest'
import { executeProviderPlan, providerClass, type DiscoveryProviderState } from './provider-router'

const green: DiscoveryProviderState = { quotaBand: 'green', circuitOpen: false, recentErrorRate: 0, remainingRatio: 1 }

describe('discovery provider router', () => {
  it('classifies free and platform providers separately from paid providers', () => {
    expect(providerClass('bundesagentur')).toBe('free')
    expect(providerClass('cleanjobdata')).toBe('platform')
    expect(providerClass('adzuna')).toBe('paid')
  })

  it('runs free providers first and stops before paid providers once the target is met', async () => {
    const called: string[] = []
    const result = await executeProviderPlan({
      calls: [{ id: 'adzuna', params: {} }, { id: 'bundesagentur', params: {} }, { id: 'remotive', params: {} }],
      availableProviders: new Set(['adzuna', 'bundesagentur', 'remotive']),
      states: new Map([['adzuna', green], ['bundesagentur', green], ['remotive', green]]),
      targetResults: 2,
      execute: async call => { called.push(call.id); return call.id === 'bundesagentur' ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }] },
      count: items => items.length,
    })
    expect(called).toContain('bundesagentur')
    expect(called).toContain('remotive')
    expect(called).not.toContain('adzuna')
    expect(result.decisions).toContainEqual(expect.objectContaining({ provider: 'adzuna', reason: 'result_target_reached' }))
  })

  it('skips exhausted and circuit-open providers before making requests', async () => {
    const called: string[] = []
    const result = await executeProviderPlan({
      calls: [{ id: 'cleanjobdata', params: {} }, { id: 'adzuna', params: {} }],
      availableProviders: new Set(['cleanjobdata', 'adzuna']),
      states: new Map([
        ['cleanjobdata', { ...green, quotaBand: 'exhausted' }],
        ['adzuna', { ...green, circuitOpen: true }],
      ]),
      targetResults: 5,
      execute: async call => { called.push(call.id); return [] },
      count: items => items.length,
    })
    expect(called).toEqual([])
    expect(result.decisions.filter(decision => decision.action === 'skipped')).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'cleanjobdata', reason: 'quota_exhausted' }),
      expect.objectContaining({ provider: 'adzuna', reason: 'circuit_open' }),
    ]))
  })

  it('falls through when an atomic quota reservation is denied', async () => {
    const called: string[] = []
    const result = await executeProviderPlan({
      calls: [{ id: 'cleanjobdata', params: {} }, { id: 'adzuna', params: {} }],
      availableProviders: new Set(['cleanjobdata', 'adzuna']),
      states: new Map([['cleanjobdata', green], ['adzuna', green]]),
      targetResults: 1,
      execute: async call => { called.push(call.id); return call.id === 'adzuna' ? [{ id: 1 }] : [{ id: 2 }] },
      count: items => items.length,
      reserve: async call => call.id === 'cleanjobdata' ? null : { settle: async () => undefined },
    })
    expect(called).toEqual(['adzuna'])
    expect(result.items).toEqual([{ id: 1 }])
    expect(result.decisions).toContainEqual(expect.objectContaining({ provider: 'cleanjobdata', reason: 'quota_reservation_denied' }))
  })

  it('records a free-provider error and continues to paid fallback', async () => {
    const result = await executeProviderPlan({
      calls: [{ id: 'irishjobs', params: {} }, { id: 'adzuna', params: {} }],
      availableProviders: new Set(['irishjobs', 'adzuna']),
      states: new Map([['irishjobs', green], ['adzuna', green]]),
      targetResults: 1,
      execute: async call => {
        if (call.id === 'irishjobs') throw new Error('rss_unavailable')
        return [{ id: 1 }]
      },
      count: items => items.length,
    })
    expect(result.items).toEqual([{ id: 1 }])
    expect(result.decisions).toContainEqual(expect.objectContaining({ provider: 'irishjobs', reason: 'provider_error' }))
    expect(result.decisions).toContainEqual(expect.objectContaining({ provider: 'adzuna', action: 'selected' }))
  })
})
