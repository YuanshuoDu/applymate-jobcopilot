import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  userFindUnique: vi.fn(),
  userDelete: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.userFindUnique, delete: mocks.userDelete } } }))

describe('DELETE /api/me/delete', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAuth.mockResolvedValue({ userId: 'user_1' })
    mocks.userFindUnique.mockResolvedValue({ email: 'member@example.com' })
  })

  it('deletes only after a case-insensitive email confirmation', async () => {
    const { DELETE } = await import('./route')
    const request = new Request('http://localhost/api/me/delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: ' MEMBER@EXAMPLE.COM ' }),
    })

    const response = await DELETE(request as never)

    expect(response.status).toBe(200)
    expect(mocks.userDelete).toHaveBeenCalledWith({ where: { id: 'user_1' } })
  })
})
