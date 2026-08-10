import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { SignJWT } from 'jose'
import { NextRequest } from 'next/server'

const GMAIL_STATE_COOKIE = 'applymate-gmail-oauth-state'

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  deleteMany: vi.fn(),
  upsert: vi.fn(),
}))
const pinnedFetch = vi.hoisted(() => vi.fn((input: string | URL, init?: unknown) => globalThis.fetch(String(input), init as RequestInit)))

vi.mock('@/lib/db', () => ({ db: { account: mocks } }))
vi.mock('@jobcopilot/shared', async () => {
  const actual = await vi.importActual<typeof import('@jobcopilot/shared')>('@jobcopilot/shared')
  return { ...actual, pinnedFetch }
})

async function state() {
  return new SignJWT({ uid: 'user_1', returnTo: '/?page=settings&tab=accounts', nonce: 'n1' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode('test-secret-which-is-long-enough'))
}

describe('GET /api/gmail/oauth/callback', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('AUTH_SECRET', 'test-secret-which-is-long-enough')
    vi.stubEnv('AUTH_GOOGLE_ID', 'google-client')
    vi.stubEnv('AUTH_GOOGLE_SECRET', 'google-secret')
    vi.stubEnv('AUTH_URL', 'https://applymate.site')
    mocks.findUnique.mockReset()
    mocks.deleteMany.mockReset()
    mocks.upsert.mockReset()
    mocks.findUnique.mockResolvedValue(null)
    mocks.deleteMany.mockResolvedValue({ count: 0 })
    mocks.upsert.mockResolvedValue({ id: 'account_1' })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600, scope: 'gmail.readonly' }), { status: 200 })
      }
      return new Response(JSON.stringify({ sub: 'google-sub-1' }), { status: 200 })
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('uses the configured callback URI for token exchange and returns to the configured app', async () => {
    const { GET } = await import('./route')
    const response = await GET(new NextRequest(
      `https://preview.vercel.app/api/gmail/oauth/callback?code=c1&state=${encodeURIComponent(await state())}`,
      { headers: { cookie: `${GMAIL_STATE_COOKIE}=n1` } },
    ))
    const location = new URL(response.headers.get('location') ?? '')
    const tokenCall = vi.mocked(fetch).mock.calls[0]
    const tokenBody = String((tokenCall?.[1] as RequestInit | undefined)?.body ?? '')

    expect(response.status).toBe(307)
    expect(tokenBody).toContain('redirect_uri=https%3A%2F%2Fapplymate.site%2Fapi%2Fgmail%2Foauth%2Fcallback')
    expect(location.origin).toBe('https://applymate.site')
    expect(location.pathname).toBe('/')
    expect(location.searchParams.get('gmailAuth')).toBe('1')
    expect(mocks.upsert).toHaveBeenCalled()
  })

  it('rejects a signed state that was not started by this browser', async () => {
    const { GET } = await import('./route')
    const response = await GET(new NextRequest(`https://preview.vercel.app/api/gmail/oauth/callback?code=c1&state=${encodeURIComponent(await state())}`))
    const location = new URL(response.headers.get('location') ?? '')

    expect(response.status).toBe(307)
    expect(location.searchParams.get('gmailError')).toBe('invalid_state')
    expect(fetch).not.toHaveBeenCalled()
    expect(mocks.upsert).not.toHaveBeenCalled()
  })
})
