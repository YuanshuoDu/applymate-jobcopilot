import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { jwtVerify } from 'jose'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ safeAuth: vi.fn(), userFindUnique: vi.fn() }))
vi.mock('@/lib/safe-auth', () => ({ safeAuth: mocks.safeAuth }))
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.userFindUnique } } }))

describe('GET /api/gmail/oauth/start', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.safeAuth.mockReset()
    mocks.safeAuth.mockResolvedValue({ user: { id: 'user_1' } })
    mocks.userFindUnique.mockReset().mockResolvedValue({ accountStatus: 'active' })
    vi.stubEnv('AUTH_SECRET', 'test-secret-which-is-long-enough')
    vi.stubEnv('AUTH_GOOGLE_ID', 'google-client')
    vi.stubEnv('AUTH_GOOGLE_SECRET', 'google-secret')
    vi.stubEnv('AUTH_CANONICAL_URL', 'https://applymate.site')
  })

  afterEach(() => vi.unstubAllEnvs())

  it('uses the configured public callback URL', async () => {
    const { GET } = await import('./route')
    const response = await GET(new NextRequest('https://preview.vercel.app/api/gmail/oauth/start'))
    const location = new URL(response.headers.get('location') ?? '')
    const cookie = response.cookies.get('applymate-gmail-oauth-state')
    const state = location.searchParams.get('state')

    expect(response.status).toBe(307)
    expect(location.origin).toBe('https://accounts.google.com')
    expect(location.searchParams.get('redirect_uri')).toBe('https://applymate.site/api/gmail/oauth/callback')
    expect(cookie).toEqual(expect.objectContaining({ httpOnly: true, sameSite: 'lax', maxAge: 600 }))
    const { payload } = await jwtVerify(state!, new TextEncoder().encode('test-secret-which-is-long-enough'))
    expect(payload.nonce).toBe(cookie?.value)
  })

  it('redirects unauthenticated users to login', async () => {
    mocks.safeAuth.mockResolvedValue(null)
    const { GET } = await import('./route')
    const response = await GET(new NextRequest('http://localhost/api/gmail/oauth/start'))
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toContain('/login')
  })
})
