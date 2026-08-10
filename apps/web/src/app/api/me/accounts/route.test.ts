import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  findMany: vi.fn(),
  deleteMany: vi.fn(),
  updateMany: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))
vi.mock('@/lib/db', () => ({ db: { $transaction: mocks.transaction, account: { findMany: mocks.findMany, deleteMany: mocks.deleteMany, updateMany: mocks.updateMany } } }))

describe('/api/me/accounts', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAuth.mockResolvedValue({ userId: 'user_1' })
    mocks.transaction.mockImplementation(async (callback: (tx: { account: { deleteMany: typeof mocks.deleteMany; updateMany: typeof mocks.updateMany } }) => unknown) => callback({ account: { deleteMany: mocks.deleteMany, updateMany: mocks.updateMany } }))
    mocks.findMany.mockResolvedValue([
      { provider: 'google', providerAccountId: 'google-1', scope: 'openid https://www.googleapis.com/auth/gmail.readonly' },
      { provider: 'github', providerAccountId: 'github-1', scope: 'read:user' },
    ])
  })

  it('normalizes legacy Google Gmail rows so Settings shows the connection', async () => {
    const { GET } = await import('./route')
    const response = await GET()
    await expect(response.json()).resolves.toEqual({ accounts: [
      { provider: 'gmail', account: 'google-1', legacy: true },
      { provider: 'github', account: 'github-1' },
    ] })
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: { provider: true, providerAccountId: true, scope: true },
    }))
  })

  it('disconnects Gmail without removing the Google login identity', async () => {
    const { DELETE } = await import('./route')
    const response = await DELETE(new Request('http://localhost/api/me/accounts', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'gmail' }),
    }) as never)

    expect(response.status).toBe(200)
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user_1', provider: 'gmail' },
    })
    expect(JSON.stringify(mocks.deleteMany.mock.calls[0])).not.toContain('google')
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user_1', provider: 'google', scope: { contains: 'gmail' } },
      data: {
        accessTokenEnc: null,
        access_token: null,
        refresh_token: null,
        refreshTokenEnc: null,
        expires_at: null,
        token_type: null,
        scope: null,
        idTokenEnc: null,
        id_token: null,
        session_state: null,
      },
    })
  })
})
