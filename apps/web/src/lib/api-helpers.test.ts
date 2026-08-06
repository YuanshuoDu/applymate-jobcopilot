import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  jwtVerify: vi.fn(),
  safeAuth: vi.fn(),
  userFindUnique: vi.fn(),
}))

vi.mock('next/headers', () => ({ headers: mocks.headers }))
vi.mock('jose', () => ({ jwtVerify: mocks.jwtVerify }))
vi.mock('@/lib/safe-auth', () => ({ safeAuth: mocks.safeAuth }))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }))
vi.mock('@/lib/model-router', () => ({ resolveFeatureConfig: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.userFindUnique } } }))

describe('requireAuth', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.headers.mockReset()
    mocks.jwtVerify.mockReset()
    mocks.safeAuth.mockReset()
    mocks.userFindUnique.mockReset()
    mocks.userFindUnique.mockResolvedValue({ accountStatus: 'active' })
    mocks.jwtVerify.mockResolvedValue({ payload: { sub: 'extension-user' } })
    mocks.safeAuth.mockResolvedValue(null)
  })

  it('accepts a verified Bearer token passed explicitly by a route', async () => {
    const { requireAuth } = await import('./api-helpers')
    const result = await requireAuth(new Request('http://localhost/api/jobs', {
      headers: { Authorization: 'Bearer extension-token' },
    }) as never)

    expect(result).toEqual({ userId: 'extension-user' })
  })

  it('reads the real request header for GET routes without a request parameter', async () => {
    mocks.headers.mockResolvedValue(new Headers({ Authorization: 'Bearer extension-token' }))
    const { requireAuth } = await import('./api-helpers')

    await expect(requireAuth()).resolves.toEqual({ userId: 'extension-user' })
  })

  it('does not trust a client-provided x-user-id header', async () => {
    mocks.headers.mockResolvedValue(new Headers({ 'x-user-id': 'forged-user' }))
    const { requireAuth } = await import('./api-helpers')
    const result = await requireAuth()

    expect(result).toBeInstanceOf(Response)
    await expect((result as Response).json()).resolves.toEqual({ error: 'Unauthorized' })
  })

  it('rejects a suspended user even when the session or extension token is valid', async () => {
    mocks.userFindUnique.mockResolvedValue({ accountStatus: 'suspended' })
    const { requireAuth } = await import('./api-helpers')
    const result = await requireAuth(new Request('http://localhost/api/jobs', { headers: { Authorization: 'Bearer extension-token' } }) as never)
    expect(result).toBeInstanceOf(Response)
    await expect((result as Response).json()).resolves.toEqual({ error: 'Account suspended' })
    expect((result as Response).status).toBe(403)
  })
})
