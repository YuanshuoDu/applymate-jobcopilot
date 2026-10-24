import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), list: vi.fn(), set: vi.fn() }))
vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (error: string, status = 400) => Response.json({ error }, { status }),
}))
vi.mock('@/lib/persona-facts', () => ({
  listDiscoveryPersonaFacts: mocks.list,
  setDiscoveryPersonaFactConsent: mocks.set,
}))

const consent = {
  factId: 'fact-1', key: 'notice_period', expectedValue: 'One month',
  expectedNormalizedValue: 'one month', expectedUpdatedAt: '2026-10-24T12:00:00.000Z', enabled: true,
}

describe('/api/me/persona/discovery', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset().mockResolvedValue({ userId: 'owner-1' })
    mocks.list.mockReset().mockResolvedValue([])
    mocks.set.mockReset().mockResolvedValue({ kind: 'updated', fact: { id: 'fact-1', allowedUses: ['discovery'] } })
  })

  it('returns only the dedicated consent projection with private cache headers', async () => {
    const facts = [{ id: 'fact-1', key: 'notice_period', allowedUses: [] }]
    mocks.list.mockResolvedValue(facts)
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/me/persona/discovery') as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ facts })
    expect(mocks.list).toHaveBeenCalledWith('owner-1')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('uses the authenticated owner and exact CAS fields, ignoring body owner IDs', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/me/persona/discovery', {
      method: 'POST', body: JSON.stringify({ ...consent, userId: 'attacker' }),
    }) as never)

    expect(response.status).toBe(200)
    expect(mocks.set).toHaveBeenCalledWith('owner-1', consent)
  })

  it('returns stale consent as 409 and does not report an applied change', async () => {
    mocks.set.mockResolvedValue({ kind: 'stale' })
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/me/persona/discovery', {
      method: 'POST', body: JSON.stringify(consent),
    }) as never)
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'persona_fact_stale' })
  })

  it('hides missing and foreign-owned facts behind the same 404', async () => {
    mocks.set.mockResolvedValue({ kind: 'not_found' })
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/me/persona/discovery', {
      method: 'POST', body: JSON.stringify(consent),
    }) as never)
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'persona_fact_not_found' })
  })

  it('rejects incomplete requests before calling the consent writer', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/me/persona/discovery', {
      method: 'POST', body: JSON.stringify({ factId: 'fact-1', enabled: 'yes' }),
    }) as never)
    expect(response.status).toBe(400)
    expect(mocks.set).not.toHaveBeenCalled()
  })
})
