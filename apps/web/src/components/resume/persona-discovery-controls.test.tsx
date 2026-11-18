import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { DiscoveryPersonaFact } from '@/lib/persona-facts'

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ lang: 'en', t: (key: string) => key }) }))

import {
  classifyDiscoveryLoadResult, createDiscoveryRequestFence, parseDiscoverySettings, parsePersonaDiscoveryCapacity,
  PersonaDiscoveryCapacitySummary, PersonaDiscoveryControls, PersonaDiscoveryFactList, PersonaDiscoveryFactRow,
  PersonaDiscoveryLoadError, requestDiscoveryConsentChange,
} from './persona-discovery-controls'

const fact: DiscoveryPersonaFact = {
  id: 'fact-1', key: 'notice_period', category: 'work', label: 'Notice period', value: 'One month',
  normalizedValue: 'one month', source: 'manual', allowedUses: ['form_fill'],
  updatedAt: '2026-10-24T12:00:00.000Z', expiresAt: null,
}

describe('persona discovery controls', () => {
  it('preserves legacy facts and treats a missing capacity summary as unknown', () => {
    const settings = parseDiscoverySettings({ facts: [fact] })
    expect(settings?.facts).toEqual([fact])
    expect(settings?.capacity.status).toBe('unknown')
    const html = renderToStaticMarkup(<PersonaDiscoveryCapacitySummary capacity={settings!.capacity} lang="en" />)
    expect(html).toContain('Capacity estimate unavailable.')
    expect(html).not.toContain('8192')
    expect(html).not.toContain('0/32')

    const unknown = parsePersonaDiscoveryCapacity({
      status: 'unknown', factCount: 7, factLimit: 32, canonicalUtf8Bytes: null, byteLimit: 8192,
    })
    const unknownHtml = renderToStaticMarkup(<PersonaDiscoveryCapacitySummary capacity={unknown} lang="en" />)
    expect(unknownHtml).not.toContain('7/32')
  })

  it('shows available fact and canonical UTF-8 byte estimates', () => {
    const capacity = parsePersonaDiscoveryCapacity({
      status: 'available', factCount: 2, factLimit: 32, canonicalUtf8Bytes: 481, byteLimit: 8192,
    })
    const html = renderToStaticMarkup(<PersonaDiscoveryCapacitySummary capacity={capacity} lang="en" />)
    expect(html).toContain('2/32 selected facts')
    expect(html).toContain('481/8192 UTF-8 bytes')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
  })

  it('withholds bytes for fact overflow and rejects inconsistent capacity data', () => {
    const overflow = parsePersonaDiscoveryCapacity({
      status: 'overflow', factCount: 33, factLimit: 32, canonicalUtf8Bytes: null,
      byteLimit: 8192, overflowReason: 'fact_limit',
    })
    const html = renderToStaticMarkup(<PersonaDiscoveryCapacitySummary capacity={overflow} lang="en" />)
    expect(html).toContain('33/32 selected facts')
    expect(html).toContain('Byte estimate is unavailable')
    expect(html).not.toContain('8192')
    expect(html).not.toContain('Capacity estimate unavailable.')

    const malformed = parsePersonaDiscoveryCapacity({
      status: 'overflow', factCount: 33, factLimit: 32, canonicalUtf8Bytes: 9999,
      byteLimit: 8192, overflowReason: 'fact_limit',
    })
    expect(malformed.status).toBe('unknown')
  })

  it('retains measured bytes for byte overflow and makes legacy loading accessible', () => {
    const capacity = parsePersonaDiscoveryCapacity({
      status: 'overflow', factCount: 3, factLimit: 32, canonicalUtf8Bytes: 9000,
      byteLimit: 8192, overflowReason: 'byte_limit',
    })
    const html = renderToStaticMarkup(<PersonaDiscoveryCapacitySummary capacity={capacity} lang="en" />)
    expect(html).toContain('9000/8192 UTF-8 bytes')
    expect(html).toContain('over the byte limit')

    const loading = renderToStaticMarkup(<PersonaDiscoveryControls refreshKey={0} />)
    expect(loading).toContain('aria-busy="true"')
    expect(loading).toContain('role="status"')
    expect(loading).toContain('Loading confirmed facts')
    expect(loading).toContain('new discovery snapshot is created')
  })

  it('does not announce empty facts after a failed GET and exposes an accessible load error', () => {
    const failedList = renderToStaticMarkup(<PersonaDiscoveryFactList facts={[]} loading={false} failed busy={{}} lang="en" onChange={vi.fn()} />)
    const emptyList = renderToStaticMarkup(<PersonaDiscoveryFactList facts={[]} loading={false} failed={false} busy={{}} lang="en" onChange={vi.fn()} />)
    const error = renderToStaticMarkup(<PersonaDiscoveryLoadError message="Could not load discovery consent settings." />)
    expect(failedList).toBe('')
    expect(emptyList).toContain('No current confirmed facts are available to select.')
    expect(error).toContain('role="alert"')
    expect(error).toContain('Could not load discovery consent settings.')
  })

  it('keeps consent off unless discovery is explicitly present', () => {
    const optedOut = renderToStaticMarkup(<PersonaDiscoveryFactRow fact={fact} lang="en" busy={false} onChange={vi.fn()} />)
    const optedIn = renderToStaticMarkup(<PersonaDiscoveryFactRow fact={{ ...fact, allowedUses: ['form_fill', 'discovery'] }} lang="en" busy={false} onChange={vi.fn()} />)
    expect(optedOut).toContain('Use this fact for job discovery')
    expect(optedOut).not.toContain('checked=""')
    expect(optedIn).toContain('checked=""')
  })

  it('sends the exact fact version and reports success only after the CAS response', async () => {
    const updated = { ...fact, allowedUses: ['form_fill', 'discovery'], updatedAt: '2026-10-24T12:00:00.001Z' }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ fact: updated }))
    const refresh = vi.fn<() => Promise<void>>()
    const result = await requestDiscoveryConsentChange(fact, true, refresh, fetcher)
    expect(fetcher).toHaveBeenCalledWith('/api/me/persona/discovery', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ factId: fact.id, key: fact.key, expectedValue: fact.value,
        expectedNormalizedValue: fact.normalizedValue, expectedUpdatedAt: fact.updatedAt, enabled: true }),
    }))
    expect(result).toEqual({ kind: 'updated', fact: updated })
    expect(fact.allowedUses).toEqual(['form_fill'])
    expect(refresh).not.toHaveBeenCalled()
  })

  it('refetches stale consent versions without returning an optimistic grant', async () => {
    const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: 'persona_fact_stale' }, { status: 409 }))
    expect(await requestDiscoveryConsentChange(fact, true, refresh, fetcher)).toEqual({ kind: 'stale' })
    expect(refresh).toHaveBeenCalledOnce()
    expect(fact.allowedUses).toEqual(['form_fill'])
  })

  it('does not claim a stale choice was refreshed when the follow-up GET fails', async () => {
    const refresh = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('GET failed'))
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: 'persona_fact_stale' }, { status: 409 }))
    expect(await requestDiscoveryConsentChange(fact, true, refresh, fetcher)).toEqual({ kind: 'stale_refresh_failed' })
    expect(refresh).toHaveBeenCalledOnce()
    expect(fact.allowedUses).toEqual(['form_fill'])
  })

  it('leaves a newer request in control when stale-consent refresh is superseded', async () => {
    const refresh = vi.fn<() => Promise<'superseded'>>().mockResolvedValue('superseded')
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: 'persona_fact_stale' }, { status: 409 }))
    expect(await requestDiscoveryConsentChange(fact, true, refresh, fetcher)).toEqual({ kind: 'stale_refresh_superseded' })
    expect(refresh).toHaveBeenCalledOnce()
    expect(fact.allowedUses).toEqual(['form_fill'])
  })

  it('fences late reads so only the latest request can replace facts or clear loading', async () => {
    const fence = createDiscoveryRequestFence()
    let facts = [fact]
    let loading = false
    let resolveOld!: (value: DiscoveryPersonaFact[]) => void
    let resolveRefresh!: (value: DiscoveryPersonaFact[]) => void
    const oldResponse = new Promise<DiscoveryPersonaFact[]>(resolve => { resolveOld = resolve })
    const refreshResponse = new Promise<DiscoveryPersonaFact[]>(resolve => { resolveRefresh = resolve })
    const startLoad = (response: Promise<DiscoveryPersonaFact[]>) => {
      const request = fence.begin(); loading = true
      return response.then(next => { if (fence.isCurrent(request)) facts = next }).finally(() => {
        if (fence.isCurrent(request)) loading = false
      })
    }
    const oldLoad = startLoad(oldResponse)
    const granted = { ...fact, allowedUses: ['form_fill', 'discovery'], updatedAt: '2026-10-24T12:00:00.001Z' }
    fence.invalidate(); facts = [granted]
    const refresh = startLoad(refreshResponse)
    resolveOld([fact]); await oldLoad
    expect(facts).toEqual([granted]); expect(loading).toBe(true)
    resolveRefresh([granted]); await refresh
    expect(facts).toEqual([granted]); expect(loading).toBe(false)
  })

  it('distinguishes superseded refreshes from current read failures', () => {
    const fence = createDiscoveryRequestFence()
    const oldRequest = fence.begin()
    const currentRequest = fence.begin()
    expect(classifyDiscoveryLoadResult(fence.isCurrent(oldRequest), false)).toBe('superseded')
    expect(classifyDiscoveryLoadResult(fence.isCurrent(currentRequest), false)).toBe('failed')
    expect(classifyDiscoveryLoadResult(fence.isCurrent(currentRequest), true)).toBe('loaded')
  })
})
