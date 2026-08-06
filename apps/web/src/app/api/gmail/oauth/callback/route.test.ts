import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { SignJWT } from 'jose'

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  fetch: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    user: { findUnique: mocks.userFindUnique },
    account: { findUnique: vi.fn(), deleteMany: vi.fn(), upsert: vi.fn() },
  },
}))
vi.mock('@/lib/gmail-connection-recovery', () => ({ canRecoverStaleGmailConnection: vi.fn() }))

describe('GET /api/gmail/oauth/callback', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('AUTH_SECRET', 'test-secret')
    mocks.userFindUnique.mockReset().mockResolvedValue({ accountStatus: 'active' })
    mocks.fetch.mockReset()
    vi.stubGlobal('fetch', mocks.fetch)
  })

  it('does not exchange or store Gmail credentials after the account is suspended', async () => {
    mocks.userFindUnique.mockResolvedValue({ accountStatus: 'suspended' })
    const state = await new SignJWT({ uid: 'user_1', returnTo: '/?page=gmail' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode('test-secret'))
    const { GET } = await import('./route')

    const response = await GET(new NextRequest(`http://localhost/api/gmail/oauth/callback?code=code&state=${encodeURIComponent(state)}`))

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toContain('gmailError=account_suspended')
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
})
