import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { DiscoveryPersonaFact } from '@/lib/persona-facts'

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ lang: 'en', t: (key: string) => key }) }))

import { createDiscoveryRequestFence, PersonaDiscoveryFactRow, PersonaPanel, requestDiscoveryConsentChange } from './PersonaPanel'

const fact: DiscoveryPersonaFact = {
  id: 'fact-1', key: 'notice_period', category: 'work', label: 'Notice period', value: 'One month',
  normalizedValue: 'one month', source: 'manual', allowedUses: ['form_fill'],
  updatedAt: '2026-10-24T12:00:00.000Z', expiresAt: null,
}

describe('PersonaPanel discovery consent', () => {
  it('shows the same-Session, model-sharing and no-action-authority disclosure', () => {
    const html = renderToStaticMarkup(<PersonaPanel isDefault onEditResume={vi.fn()} onUseAsProfile={vi.fn()} />)
    expect(html).toContain('Discovery preferences')
    expect(html).toContain('sent to your configured AI model')
    expect(html).toContain('may reuse an existing Session')
    expect(html).toContain('does not authorize applications or other actions')
  })

  it('renders existing facts opted out unless discovery is explicitly present', () => {
    const optedOut = renderToStaticMarkup(<PersonaDiscoveryFactRow fact={fact} lang="en" busy={false} onChange={vi.fn()} />)
    expect(optedOut).toContain('Use this fact for job discovery')
    expect(optedOut).not.toContain('checked=""')
    const optedIn = renderToStaticMarkup(<PersonaDiscoveryFactRow fact={{ ...fact, allowedUses: ['form_fill', 'discovery'] }} lang="en" busy={false} onChange={vi.fn()} />)
    expect(optedIn).toContain('checked=""')
  })

  it('sends the exact fact version and reports success only after the CAS response', async () => {
    const updated = { ...fact, allowedUses: ['form_fill', 'discovery'], updatedAt: '2026-10-24T12:00:00.001Z' }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ fact: updated }))
    const refresh = vi.fn<() => Promise<void>>()
    const result = await requestDiscoveryConsentChange(fact, true, refresh, fetcher)

    expect(fetcher).toHaveBeenCalledWith('/api/me/persona/discovery', expect.objectContaining({
      method: 'POST', body: JSON.stringify({
        factId: fact.id, key: fact.key, expectedValue: fact.value, expectedNormalizedValue: fact.normalizedValue,
        expectedUpdatedAt: fact.updatedAt, enabled: true,
      }),
    }))
    expect(result).toEqual({ kind: 'updated', fact: updated })
    expect(fact.allowedUses).toEqual(['form_fill'])
    expect(refresh).not.toHaveBeenCalled()
  })

  it('refetches on stale CAS and does not return an optimistic grant', async () => {
    const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: 'persona_fact_stale' }, { status: 409 }))
    const result = await requestDiscoveryConsentChange(fact, true, refresh, fetcher)
    expect(result).toEqual({ kind: 'stale' })
    expect(refresh).toHaveBeenCalledOnce()
    expect(fact.allowedUses).toEqual(['form_fill'])
  })

  it('fences a late pre-consent GET and lets only the active refetch clear loading', async () => {
    const fence = createDiscoveryRequestFence()
    let facts = [fact]
    let loading = false
    let resolveOld!: (value: DiscoveryPersonaFact[]) => void
    let resolveRefresh!: (value: DiscoveryPersonaFact[]) => void
    const oldResponse = new Promise<DiscoveryPersonaFact[]>(resolve => { resolveOld = resolve })
    const refreshResponse = new Promise<DiscoveryPersonaFact[]>(resolve => { resolveRefresh = resolve })
    const startLoad = (response: Promise<DiscoveryPersonaFact[]>) => {
      const request = fence.begin()
      loading = true
      return response.then(next => {
        if (fence.isCurrent(request)) facts = next
      }).finally(() => {
        if (fence.isCurrent(request)) loading = false
      })
    }

    const oldLoad = startLoad(oldResponse)
    const granted = { ...fact, allowedUses: ['form_fill', 'discovery'], updatedAt: '2026-10-24T12:00:00.001Z' }
    fence.invalidate()
    facts = [granted]
    const refresh = startLoad(refreshResponse)

    resolveOld([fact])
    await oldLoad
    expect(facts).toEqual([granted])
    expect(loading).toBe(true)

    resolveRefresh([granted])
    await refresh
    expect(facts).toEqual([granted])
    expect(loading).toBe(false)
  })
})
