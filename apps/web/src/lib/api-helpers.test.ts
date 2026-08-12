import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  jwtVerify: vi.fn(),
  safeAuth: vi.fn(),
  userFindUnique: vi.fn(),
  userFindMany: vi.fn(),
}))

vi.mock('next/headers', () => ({ headers: mocks.headers }))
vi.mock('jose', () => ({ jwtVerify: mocks.jwtVerify }))
vi.mock('@/lib/safe-auth', () => ({ safeAuth: mocks.safeAuth }))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }))
vi.mock('@/lib/model-router', () => ({ resolveFeatureConfig: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.userFindUnique, findMany: mocks.userFindMany } } }))

describe('requireAuth', () => {
  const updatedAt = new Date('2026-08-10T09:00:00.000Z')
  const authVersion = 1

  beforeEach(() => {
    vi.resetModules()
    mocks.headers.mockReset()
    mocks.jwtVerify.mockReset()
    mocks.safeAuth.mockReset()
    mocks.userFindUnique.mockReset()
    mocks.userFindMany.mockReset()
    mocks.jwtVerify.mockResolvedValue({ payload: { sub: 'extension-user', authVersion } })
    mocks.safeAuth.mockResolvedValue(null)
    mocks.userFindUnique.mockResolvedValue({ accountStatus: 'active', authVersion, updatedAt })
    mocks.userFindMany.mockResolvedValue([{ id: 'legacy-user', accountStatus: 'active', authVersion, updatedAt }])
  })

  it('accepts a verified Bearer token passed explicitly by a route', async () => {
    const { requireAuth } = await import('./api-helpers')
    const result = await requireAuth(new Request('http://localhost/api/jobs', {
      headers: { Authorization: 'Bearer extension-token' },
    }) as never)

    expect(result).toEqual({ userId: 'extension-user' })
    expect(mocks.jwtVerify).toHaveBeenCalledWith('extension-token', expect.anything(), {
      issuer: 'applymate-extension',
      audience: 'applymate-extension',
    })
  })

  it('reads the real request header for GET routes without a request parameter', async () => {
    mocks.headers.mockResolvedValue(new Headers({ Authorization: 'Bearer extension-token' }))
    const { requireAuth } = await import('./api-helpers')

    await expect(requireAuth()).resolves.toEqual({ userId: 'extension-user' })
  })

  it('keeps normal web sessions working without an extension-token revision claim', async () => {
    mocks.headers.mockResolvedValue(new Headers())
    mocks.safeAuth.mockResolvedValue({ user: { id: 'web-user' } })
    mocks.userFindUnique.mockResolvedValue({ accountStatus: 'active', authVersion, updatedAt })
    const { requireAuth } = await import('./api-helpers')

    await expect(requireAuth()).resolves.toEqual({ userId: 'web-user' })
  })

  it('recovers an initial-version legacy web session from its signed email', async () => {
    mocks.headers.mockResolvedValue(new Headers())
    mocks.safeAuth.mockResolvedValue({ user: { email: 'candidate@example.com' } })
    mocks.userFindMany.mockResolvedValue([{ id: 'legacy-user', accountStatus: 'active', authVersion: 1, updatedAt }])
    const { requireAuth } = await import('./api-helpers')

    await expect(requireAuth()).resolves.toEqual({ userId: 'legacy-user' })
    expect(mocks.userFindMany).toHaveBeenCalledWith({
      where: { email: { equals: 'candidate@example.com', mode: 'insensitive' } },
      select: { id: true, accountStatus: true, authVersion: true },
      take: 2,
    })
  })

  it('does not recover an email-only session after its auth version changes', async () => {
    mocks.headers.mockResolvedValue(new Headers())
    mocks.safeAuth.mockResolvedValue({ user: { email: 'candidate@example.com' } })
    mocks.userFindMany.mockResolvedValue([{ id: 'legacy-user', accountStatus: 'active', authVersion: 2, updatedAt }])
    const { requireAuth } = await import('./api-helpers')

    const result = await requireAuth()

    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(401)
  })

  it.each([
    [null, 401],
    [{ id: 'legacy-user', accountStatus: 'suspended', authVersion: 1, updatedAt }, 403],
  ])('fails closed for an email-only session when the account is unsafe: %o', async (user, status) => {
    mocks.headers.mockResolvedValue(new Headers())
    mocks.safeAuth.mockResolvedValue({ user: { email: 'candidate@example.com' } })
    mocks.userFindMany.mockResolvedValue(user ? [user] : [])
    const { requireAuth } = await import('./api-helpers')

    const result = await requireAuth()

    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(status)
  })

  it('rejects a web session after a security-sensitive auth version change', async () => {
    mocks.headers.mockResolvedValue(new Headers())
    mocks.safeAuth.mockResolvedValue({ user: { id: 'web-user', authVersion: 1 } })
    mocks.userFindUnique.mockResolvedValue({ accountStatus: 'active', authVersion: 2, updatedAt })
    const { requireAuth } = await import('./api-helpers')

    const result = await requireAuth()

    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(401)
  })

  it('accepts a legacy bearer token after an unrelated profile update', async () => {
    mocks.jwtVerify.mockResolvedValue({ payload: { sub: 'extension-user', iat: Math.floor(updatedAt.getTime() / 1000) } })
    const { requireAuth } = await import('./api-helpers')
    const result = await requireAuth(new Request('http://localhost/api/jobs', {
      headers: { Authorization: 'Bearer legacy-extension-token' },
    }) as never)

    expect(result).toEqual({ userId: 'extension-user' })
  })

  it('rejects a bearer token after a security-sensitive auth version change', async () => {
    mocks.userFindUnique.mockResolvedValue({ accountStatus: 'active', authVersion: 2 })
    const { requireAuth } = await import('./api-helpers')
    const result = await requireAuth(new Request('http://localhost/api/jobs', {
      headers: { Authorization: 'Bearer extension-token' },
    }) as never)

    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(401)
  })

  it('does not trust a client-provided x-user-id header', async () => {
    mocks.headers.mockResolvedValue(new Headers({ 'x-user-id': 'forged-user' }))
    const { requireAuth } = await import('./api-helpers')
    const result = await requireAuth()

    expect(result).toBeInstanceOf(Response)
    await expect((result as Response).json()).resolves.toEqual({ error: 'Unauthorized' })
  })

  it('rejects a signed token for a user that no longer exists', async () => {
    mocks.userFindUnique.mockResolvedValue(null)
    const { requireAuth } = await import('./api-helpers')
    const result = await requireAuth(new Request('http://localhost/api/jobs', {
      headers: { Authorization: 'Bearer extension-token' },
    }) as never)

    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(401)
  })

  it('does not fall back to a browser session after Bearer verification fails', async () => {
    mocks.jwtVerify.mockRejectedValue(new Error('expired'))
    mocks.safeAuth.mockResolvedValue({ user: { id: 'cookie-user' } })
    const { requireAuth } = await import('./api-helpers')
    const result = await requireAuth(new Request('http://localhost/api/jobs', {
      headers: { Authorization: 'Bearer expired-extension-token' },
    }) as never)

    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(401)
    expect(mocks.safeAuth).not.toHaveBeenCalled()
  })
})
