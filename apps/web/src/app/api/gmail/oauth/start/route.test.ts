import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  safeAuth: vi.fn(),
  userFindUnique: vi.fn(),
}))

vi.mock('@/lib/safe-auth', () => ({ safeAuth: mocks.safeAuth }))
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.userFindUnique } } }))

describe('GET /api/gmail/oauth/start', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('AUTH_GOOGLE_ID', 'google-client-id')
    mocks.safeAuth.mockReset().mockResolvedValue({ user: { id: 'user_1' } })
    mocks.userFindUnique.mockReset().mockResolvedValue({ accountStatus: 'active' })
  })

  it('does not start Gmail OAuth for a suspended account', async () => {
    mocks.userFindUnique.mockResolvedValue({ accountStatus: 'suspended' })
    const { GET } = await import('./route')

    const response = await GET(new NextRequest('http://localhost/api/gmail/oauth/start'))

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'Account suspended' })
  })
})
