import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  compare: vi.fn(),
  hash: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.findUnique, update: mocks.update } } }))
vi.mock('bcryptjs', () => ({ default: { compare: mocks.compare, hash: mocks.hash } }))

describe('PATCH /api/me/password', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAuth.mockResolvedValue({ userId: 'user_1' })
    mocks.findUnique.mockResolvedValue({ password: 'hashed-old' })
    mocks.compare.mockResolvedValue(true)
    mocks.hash.mockResolvedValue('hashed-new')
  })

  it('rejects non-string password fields without throwing', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/api/me/password', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 123, newPassword: 'long-enough-password' }),
    }) as never)
    expect(response.status).toBe(400)
    expect(mocks.compare).not.toHaveBeenCalled()
  })
})
