import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  safeAuth: vi.fn(),
  userFindUnique: vi.fn(),
}))

vi.mock('@/lib/safe-auth', () => ({ safeAuth: mocks.safeAuth }))
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.userFindUnique } } }))

describe('GET /api/auth/me/extension-token', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.safeAuth.mockReset().mockResolvedValue({ user: { id: 'user_1' } })
    mocks.userFindUnique.mockReset().mockResolvedValue({ id: 'user_1', email: 'user@example.com', name: 'User', plan: 'pro', accountStatus: 'active' })
  })

  it('does not mint an extension token for a suspended account', async () => {
    mocks.userFindUnique.mockResolvedValue({ id: 'user_1', accountStatus: 'suspended' })
    const { GET } = await import('./route')

    const response = await GET()

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'Account suspended' })
  })
})
