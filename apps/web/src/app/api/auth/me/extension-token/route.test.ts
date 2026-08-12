import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  safeAuth: vi.fn(),
  userFindUnique: vi.fn(),
  sign: vi.fn(),
  payloads: [] as unknown[],
}))

vi.mock('@/lib/safe-auth', () => ({ safeAuth: mocks.safeAuth }))
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.userFindUnique } } }))
vi.mock('@/lib/auth-secret', () => ({
  EXTENSION_TOKEN_AUDIENCE: 'applymate-extension',
  EXTENSION_TOKEN_ISSUER: 'applymate-extension',
  getAuthJwtSecret: () => new TextEncoder().encode('extension-token-test-secret'),
}))
vi.mock('jose', () => ({
  SignJWT: class {
    constructor(payload: unknown) { mocks.payloads.push(payload) }
    setProtectedHeader() { return this }
    setIssuer() { return this }
    setAudience() { return this }
    setIssuedAt() { return this }
    setExpirationTime() { return this }
    sign() { return mocks.sign() }
  },
}))

describe('GET /api/auth/me/extension-token', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.safeAuth.mockReset().mockResolvedValue({ user: { id: 'user_1', authVersion: 1 } })
    mocks.userFindUnique.mockReset().mockResolvedValue({ id: 'user_1', email: 'user@example.com', name: 'User', plan: 'pro', accountStatus: 'active', authVersion: 1 })
    mocks.sign.mockReset().mockResolvedValue('extension-token')
    mocks.payloads.length = 0
  })

  it('does not mint an extension token for a suspended account', async () => {
    mocks.userFindUnique.mockResolvedValue({ id: 'user_1', accountStatus: 'suspended' })
    const { GET } = await import('./route')

    const response = await GET()

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'Account unavailable' })
  })

  it('includes the auth version required by the credentials bridge', async () => {
    const { GET } = await import('./route')
    const response = await GET()

    expect(response.status).toBe(200)
    expect(mocks.payloads).toContainEqual(expect.objectContaining({ sub: 'user_1', authVersion: 1 }))
  })

  it('does not mint a token from a stale dashboard session', async () => {
    mocks.safeAuth.mockResolvedValue({ user: { id: 'user_1', authVersion: 1 } })
    mocks.userFindUnique.mockResolvedValue({ id: 'user_1', email: 'user@example.com', accountStatus: 'active', authVersion: 2 })
    const { GET } = await import('./route')

    const response = await GET()

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Session expired' })
    expect(mocks.sign).not.toHaveBeenCalled()
  })
})
