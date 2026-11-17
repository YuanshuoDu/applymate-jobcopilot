import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  db: {},
  deleteAccount: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))
vi.mock('@/lib/db', () => ({ db: mocks.db }))
vi.mock('@/lib/agent/account-delete-source-write', () => ({ deleteAccountWithSourceFence: mocks.deleteAccount }))

describe('DELETE /api/me/delete', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset()
    mocks.deleteAccount.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: 'user_1' })
    mocks.deleteAccount.mockResolvedValue('deleted')
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
    expect(mocks.deleteAccount).toHaveBeenCalledWith(mocks.db, 'user_1', ' MEMBER@EXAMPLE.COM ')
  })

  it('preserves not-found and confirmation errors from the fenced transaction', async () => {
    const { DELETE } = await import('./route')
    mocks.deleteAccount.mockResolvedValueOnce('not_found')
    const notFound = await DELETE(new Request('http://localhost/api/me/delete', { method: 'DELETE' }) as never)
    expect(notFound.status).toBe(404)

    mocks.deleteAccount.mockResolvedValueOnce('confirmation_required')
    const invalid = await DELETE(new Request('http://localhost/api/me/delete', { method: 'DELETE' }) as never)
    expect(invalid.status).toBe(400)
  })

  it('does not invoke deletion when authentication fails', async () => {
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }))
    const { DELETE } = await import('./route')

    const response = await DELETE(new Request('http://localhost/api/me/delete', { method: 'DELETE' }) as never)

    expect(response.status).toBe(401)
    expect(mocks.deleteAccount).not.toHaveBeenCalled()
  })
})
