import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  findUnique: vi.fn(),
  upsert: vi.fn(),
  getDiscoveryApiAccess: vi.fn(),
  getDiscoveryApiKeyStatus: vi.fn(),
  encryptDiscoveryApiKey: vi.fn(async (_field: unknown, value: string) => `enc:${value}`),
}))

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))
vi.mock('@/lib/db', () => ({ db: { userApiKeys: { findUnique: mocks.findUnique, upsert: mocks.upsert } } }))
vi.mock('@/lib/discovery-api-keys', () => ({
  getDiscoveryApiAccess: mocks.getDiscoveryApiAccess,
  getDiscoveryApiKeyStatus: mocks.getDiscoveryApiKeyStatus,
  encryptDiscoveryApiKey: mocks.encryptDiscoveryApiKey,
}))

function request(body: unknown) {
  return new Request('http://localhost/api/me/api-keys', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
}

describe('/api/me/api-keys', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAuth.mockResolvedValue({ userId: 'user_1' })
    mocks.upsert.mockResolvedValue({ adzunaAppId: 'id', adzunaAppKey: 'key', rapidapiKey: null })
    mocks.findUnique.mockResolvedValue({ adzunaAppId: 'id', adzunaAppKey: 'key', rapidapiKey: null })
    mocks.getDiscoveryApiKeyStatus.mockResolvedValue({
      hasAdzuna: true, hasRapidapi: false, userHasAdzuna: true, userHasRapidapi: false,
      adzunaSource: 'user', rapidapiSource: 'none', needsAdzunaPair: false,
    })
  })

  it('rejects non-string credentials before writing', async () => {
    const { POST } = await import('./route')
    const response = await POST(request({ rapidapiKey: { value: 'secret' } }) as never)
    expect(response.status).toBe(400)
    expect(mocks.upsert).not.toHaveBeenCalled()
  })

  it('supports explicit credential clearing', async () => {
    const { POST } = await import('./route')
    const response = await POST(request({ rapidapiKey: null }) as never)
    expect(response.status).toBe(200)
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: { rapidapiKey: null, rapidapiKeyEnc: null },
    }))
  })

  it('returns presence-only status from GET', async () => {
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/me/api-keys') as never)
    await expect(response.json()).resolves.toMatchObject({ hasAdzuna: true, hasRapidapi: false, adzunaSource: 'user' })
  })
})
