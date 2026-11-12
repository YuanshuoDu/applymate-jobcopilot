import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), get: vi.fn(), set: vi.fn() }))
vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (error: string, status = 400) => Response.json({ error }, { status }),
}))
vi.mock('@/lib/agent-search-footprint-memory-consent', () => ({
  getAgentSearchFootprintMemoryConsent: mocks.get,
  setAgentSearchFootprintMemoryConsent: mocks.set,
}))

function request(body?: unknown) {
  return new Request('http://localhost/api/me/agent-search-footprint-memory', {
    method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

describe('/api/me/agent-search-footprint-memory', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset().mockResolvedValue({ userId: 'owner-1' })
    mocks.get.mockReset().mockResolvedValue({ enabled: false, version: 0 })
    mocks.set.mockReset().mockResolvedValue({ kind: 'updated', consent: { enabled: true, version: 1 } })
  })

  it('reads only the authenticated user setting with private no-store headers', async () => {
    const { GET } = await import('./route')
    const response = await GET(request() as never)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ enabled: false, version: 0 })
    expect(mocks.get).toHaveBeenCalledWith('owner-1')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('accepts only enabled and expectedVersion and returns the versioned update', async () => {
    const { POST } = await import('./route')
    const response = await POST(request({ enabled: true, expectedVersion: 0 }) as never)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ enabled: true, version: 1 })
    expect(mocks.set).toHaveBeenCalledWith('owner-1', { enabled: true, expectedVersion: 0 })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('rejects malformed or client-selected requests before writing', async () => {
    const { POST } = await import('./route')
    for (const body of [
      { enabled: true, expectedVersion: 0, userId: 'other' }, { enabled: 'yes', expectedVersion: 0 },
      { enabled: true, expectedVersion: -1 }, { enabled: true, expectedVersion: 0.5 }, { enabled: true },
    ]) {
      const response = await POST(request(body) as never)
      expect(response.status).toBe(400)
      expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    }
    expect(mocks.set).not.toHaveBeenCalled()
  })

  it('returns stale, exhausted, missing-user, and unauthorized outcomes without leaking cacheable data', async () => {
    const { GET, POST } = await import('./route')
    mocks.set.mockResolvedValueOnce({ kind: 'stale', consent: { enabled: true, version: 4 } })
    const stale = await POST(request({ enabled: false, expectedVersion: 3 }) as never)
    expect(stale.status).toBe(409)
    await expect(stale.json()).resolves.toEqual({ error: 'VERSION_CONFLICT', enabled: true, version: 4 })
    mocks.set.mockResolvedValueOnce({ kind: 'version_exhausted', consent: { enabled: true, version: 2_147_483_647 } })
    expect((await POST(request({ enabled: false, expectedVersion: 2_147_483_647 }) as never)).status).toBe(409)
    mocks.get.mockResolvedValueOnce(null)
    expect((await GET(request() as never)).status).toBe(404)
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }))
    expect((await GET(request() as never)).status).toBe(401)
    expect(stale.headers.get('Cache-Control')).toBe('private, no-store')
  })
})
