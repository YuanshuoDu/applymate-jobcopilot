import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jwtVerify } from 'jose'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ safeAuth: vi.fn() }))
vi.mock('@/lib/safe-auth', () => ({ safeAuth: mocks.safeAuth }))

describe('GET /api/github/oauth/start', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.safeAuth.mockReset().mockResolvedValue({ user: { id: 'user_1' } })
    vi.stubEnv('AUTH_SECRET', 'test-secret-which-is-long-enough')
    vi.stubEnv('AUTH_GITHUB_ID', 'github-client')
    vi.stubEnv('AUTH_GITHUB_SECRET', 'github-secret')
    vi.stubEnv('AUTH_URL', 'https://applymate.site')
  })

  afterEach(() => vi.unstubAllEnvs())

  it('binds the signed state to a browser-only cookie', async () => {
    const { GET } = await import('./route')
    const response = await GET(new NextRequest('https://preview.vercel.app/api/github/oauth/start'))
    const location = new URL(response.headers.get('location') ?? '')
    const cookie = response.cookies.get('applymate-github-oauth-state')
    const state = location.searchParams.get('state')

    expect(response.status).toBe(307)
    expect(cookie).toEqual(expect.objectContaining({ httpOnly: true, sameSite: 'lax', maxAge: 600 }))
    expect(state).toBeTruthy()
    const { payload } = await jwtVerify(state!, new TextEncoder().encode('test-secret-which-is-long-enough'))
    expect(payload.nonce).toBe(cookie?.value)
  })

  it('fails safely when the OAuth state signing secret is missing', async () => {
    vi.stubEnv('AUTH_SECRET', '')
    const { GET } = await import('./route')
    const response = await GET(new NextRequest('https://preview.vercel.app/api/github/oauth/start'))

    expect(response.status).toBe(503)
  })
})
