import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (error: string, status = 400) => Response.json({ error }, { status }),
}))
vi.mock('@/lib/agent-task-history-memory-consent', () => ({
  getAgentTaskHistoryMemoryConsent: mocks.get,
  setAgentTaskHistoryMemoryConsent: mocks.set,
}))

function request(body?: unknown) {
  return new Request('http://localhost/api/me/agent-task-history-memory', {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function expectPrivateInternalError(response: Response) {
  expect(response.status).toBe(500)
  const payload = await response.json()
  expect(payload).toEqual({ error: 'internal_error' })
  expect(JSON.stringify(payload)).not.toContain('secret')
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
}

describe('/api/me/agent-task-history-memory', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset().mockResolvedValue({ userId: 'owner-1' })
    mocks.get.mockReset().mockResolvedValue({ enabled: false, version: 0 })
    mocks.set.mockReset().mockResolvedValue({ kind: 'updated', consent: { enabled: true, version: 1 } })
  })

  it('returns only the authenticated user consent setting and version with private cache headers', async () => {
    const { GET } = await import('./route')
    const response = await GET(request() as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ enabled: false, version: 0 })
    expect(mocks.get).toHaveBeenCalledWith('owner-1')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('uses the authenticated owner and accepts only the explicit CAS request fields', async () => {
    const { POST } = await import('./route')
    const response = await POST(request({ enabled: true, expectedVersion: 0 }) as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ enabled: true, version: 1 })
    expect(mocks.set).toHaveBeenCalledWith('owner-1', { enabled: true, expectedVersion: 0 })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('returns the current setting and version on a stale consent mutation', async () => {
    mocks.set.mockResolvedValueOnce({ kind: 'stale', consent: { enabled: true, version: 4 } })
    const { POST } = await import('./route')
    const response = await POST(request({ enabled: false, expectedVersion: 3 }) as never)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'VERSION_CONFLICT', enabled: true, version: 4 })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('rejects an attempted user selector or malformed CAS before writing', async () => {
    const { POST } = await import('./route')
    for (const body of [
      { enabled: true, expectedVersion: 0, userId: 'attacker' },
      { enabled: 'yes', expectedVersion: 0 },
      { enabled: true, expectedVersion: -1 },
      { enabled: true, expectedVersion: 0.5 },
      { enabled: true },
    ]) {
      const response = await POST(request(body) as never)
      expect(response.status).toBe(400)
      expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    }
    expect(mocks.set).not.toHaveBeenCalled()
  })

  it('returns private no-store user-not-found and authentication responses', async () => {
    mocks.get.mockResolvedValueOnce(null)
    const { GET } = await import('./route')
    const missing = await GET(request() as never)
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toEqual({ error: 'user_not_found' })
    expect(missing.headers.get('Cache-Control')).toBe('private, no-store')

    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }))
    const unauthorized = await GET(request() as never)
    expect(unauthorized.status).toBe(401)
    expect(unauthorized.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('returns generic private errors when auth, consent reads, or consent writes throw', async () => {
    const { GET, POST } = await import('./route')

    mocks.requireAuth.mockRejectedValueOnce(new Error('secret auth detail'))
    await expectPrivateInternalError(await GET(request() as never))

    mocks.get.mockRejectedValueOnce(new Error('secret database detail'))
    await expectPrivateInternalError(await GET(request() as never))

    mocks.requireAuth.mockRejectedValueOnce(new Error('secret auth detail'))
    await expectPrivateInternalError(await POST(request({ enabled: true, expectedVersion: 0 }) as never))

    mocks.set.mockRejectedValueOnce(new Error('secret write detail'))
    await expectPrivateInternalError(await POST(request({ enabled: true, expectedVersion: 0 }) as never))
  })

  it('keeps the exhausted-version conflict private and excludes implementation details', async () => {
    mocks.set.mockResolvedValueOnce({ kind: 'version_exhausted', consent: { enabled: true, version: 2_147_483_647 } })
    const { POST } = await import('./route')
    const response = await POST(request({ enabled: false, expectedVersion: 2_147_483_647 }) as never)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'VERSION_EXHAUSTED', enabled: true, version: 2_147_483_647 })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })
})
