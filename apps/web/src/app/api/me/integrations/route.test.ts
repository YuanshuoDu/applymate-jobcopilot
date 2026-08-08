import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn() }))

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))

describe('GET /api/me/integrations', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockResolvedValue({ userId: 'user-1' })
    vi.stubEnv('AUTH_GOOGLE_ID', '')
    vi.stubEnv('AUTH_GOOGLE_SECRET', '')
    vi.stubEnv('AUTH_GITHUB_ID', '')
    vi.stubEnv('AUTH_GITHUB_SECRET', '')
    vi.stubEnv('AUTH_SECRET', '')
  })

  afterEach(() => vi.unstubAllEnvs())

  it('does not advertise OAuth providers until their credentials and state secret are configured', async () => {
    const { GET } = await import('./route')

    const response = await GET()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ providers: { gmail: false, github: false } })
  })

  it('advertises only fully configured OAuth providers', async () => {
    vi.stubEnv('AUTH_GOOGLE_ID', 'google-client')
    vi.stubEnv('AUTH_GOOGLE_SECRET', 'google-secret')
    vi.stubEnv('AUTH_SECRET', 'state-secret')
    const { GET } = await import('./route')

    await expect((await GET()).json()).resolves.toEqual({ providers: { gmail: true, github: false } })
  })

  it('returns the authentication response without exposing integration state', async () => {
    const unauthorized = Response.json({ error: 'Unauthorized' }, { status: 401 })
    mocks.requireAuth.mockResolvedValueOnce(unauthorized)
    const { GET } = await import('./route')

    expect(await GET()).toBe(unauthorized)
  })
})
