import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  compare: vi.fn(),
  findUnique: vi.fn(),
  rateLimit: vi.fn(),
  sign: vi.fn(),
  payloads: [] as unknown[],
}))

vi.mock('bcryptjs', () => ({ default: { compare: mocks.compare } }))
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.findUnique } } }))
vi.mock('@/lib/auth-rate-limit', () => ({ checkAuthRateLimit: mocks.rateLimit }))
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

describe('POST /api/auth/extension-token', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.compare.mockReset()
    mocks.findUnique.mockReset()
    mocks.rateLimit.mockReset().mockResolvedValue({ ok: true })
    mocks.sign.mockReset().mockResolvedValue('extension-token')
    mocks.payloads.length = 0
  })

  it('does not issue a token to a non-active account', async () => {
    mocks.findUnique.mockResolvedValue({ id: 'user_1', password: 'hashed', accountStatus: 'suspended' })
    const { POST } = await import('./route')

    const response = await POST(new NextRequest('http://localhost/api/auth/extension-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', password: 'password' }),
    }))

    expect(response.status).toBe(401)
    expect(mocks.compare).not.toHaveBeenCalled()
    expect(mocks.sign).not.toHaveBeenCalled()
  })

  it('binds an active extension token to the user auth version', async () => {
    mocks.findUnique.mockResolvedValue({ id: 'user_1', email: 'user@example.com', name: 'User', password: 'hashed', plan: 'pro', accountStatus: 'active', authVersion: 3 })
    mocks.compare.mockResolvedValue(true)
    const { POST } = await import('./route')

    const response = await POST(new NextRequest('http://localhost/api/auth/extension-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ' USER@example.com ', password: 'password' }),
    }))

    expect(response.status).toBe(200)
    expect(mocks.payloads).toContainEqual(expect.objectContaining({ sub: 'user_1', authVersion: 3 }))
  })
})
