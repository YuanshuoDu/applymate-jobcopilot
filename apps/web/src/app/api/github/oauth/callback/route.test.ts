import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SignJWT } from 'jose'
import { NextRequest } from 'next/server'

const GITHUB_STATE_COOKIE = 'applymate-github-oauth-state'

const mocks = vi.hoisted(() => ({
  accountFindUnique: vi.fn(),
  accountDeleteMany: vi.fn(),
  accountUpsert: vi.fn(),
  userFindUnique: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ db: {
  account: {
    findUnique: mocks.accountFindUnique,
    deleteMany: mocks.accountDeleteMany,
    upsert: mocks.accountUpsert,
  },
  user: { findUnique: mocks.userFindUnique },
} }))

describe('GET /api/github/oauth/callback', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('AUTH_SECRET', 'test-secret-which-is-long-enough')
    vi.stubEnv('AUTH_GITHUB_ID', 'github-client')
    vi.stubEnv('AUTH_GITHUB_SECRET', 'github-secret')
    vi.stubEnv('AUTH_URL', 'https://applymate.site')
    mocks.accountFindUnique.mockReset().mockResolvedValue(null)
    mocks.accountDeleteMany.mockReset().mockResolvedValue({ count: 0 })
    mocks.accountUpsert.mockReset().mockResolvedValue({})
    mocks.userFindUnique.mockReset().mockResolvedValue({ id: 'user_1' })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('exchanges the code against the configured callback and redirects to the configured origin', async () => {
    const state = await new SignJWT({ uid: 'user_1', returnTo: '/?page=settings&tab=accounts', nonce: 'nonce-1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode('test-secret-which-is-long-enough'))
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token-1', token_type: 'bearer', scope: 'read:user' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 42 }), { status: 200 }))

    const { GET } = await import('./route')
    const response = await GET(new NextRequest(
      `https://preview.vercel.app/api/github/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `${GITHUB_STATE_COOKIE}=nonce-1` } },
    ))

    expect(response.status).toBe(307)
    expect(new URL(response.headers.get('location') ?? '').origin).toBe('https://applymate.site')
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      body: expect.stringContaining('https://applymate.site/api/github/oauth/callback'),
    }))
    expect(mocks.accountUpsert).toHaveBeenCalled()
  })

  it('rejects a signed state that was not started by this browser', async () => {
    const state = await new SignJWT({ uid: 'user_1', returnTo: '/?page=settings&tab=accounts', nonce: 'nonce-1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode('test-secret-which-is-long-enough'))
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    const { GET } = await import('./route')
    const response = await GET(new NextRequest(`https://preview.vercel.app/api/github/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`))
    const location = new URL(response.headers.get('location') ?? '')

    expect(response.status).toBe(307)
    expect(location.searchParams.get('githubError')).toBe('invalid_state')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.accountUpsert).not.toHaveBeenCalled()
  })
})
