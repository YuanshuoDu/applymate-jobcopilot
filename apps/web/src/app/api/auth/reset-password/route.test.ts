import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hashPasswordResetToken } from '@/lib/password-reset'

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  tokenFindUnique: vi.fn(),
  tokenDeleteMany: vi.fn(),
  userUpdate: vi.fn(),
  hash: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: { $transaction: mocks.transaction },
}))

vi.mock('bcryptjs', () => ({
  default: { hash: mocks.hash },
}))

vi.mock('@/lib/api-helpers', () => ({
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))

function request(body: unknown) {
  return new Request('http://localhost:3000/api/auth/reset-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('reset password API', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.hash.mockResolvedValue('new-password-hash')
    mocks.tokenDeleteMany.mockResolvedValue({ count: 1 })
    mocks.userUpdate.mockResolvedValue({ id: 'user_1' })
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      verificationToken: {
        findUnique: mocks.tokenFindUnique,
        deleteMany: mocks.tokenDeleteMany,
      },
      user: { update: mocks.userUpdate },
    }))
  })

  it('updates the user password after atomically consuming a valid token', async () => {
    const token = 'a'.repeat(43)
    const tokenHash = hashPasswordResetToken(token)
    mocks.tokenFindUnique.mockResolvedValue({
      identifier: 'password-reset:user_1',
      expires: new Date(Date.now() + 60_000),
    })
    const { POST } = await import('./route')
    const response = await POST(request({ token, password: 'new-password' }) as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(mocks.hash).toHaveBeenCalledWith('new-password', 12)
    expect(mocks.tokenFindUnique).toHaveBeenCalledWith({
      where: { token: tokenHash },
      select: { identifier: true, expires: true },
    })
    expect(mocks.tokenDeleteMany).toHaveBeenCalledWith({
      where: {
        identifier: 'password-reset:user_1',
        token: tokenHash,
        expires: { gt: expect.any(Date) },
      },
    })
    expect(mocks.userUpdate).toHaveBeenCalledWith({
      where: { id: 'user_1' },
      data: { password: 'new-password-hash' },
    })
  })

  it('rejects an expired token without changing the password', async () => {
    mocks.tokenFindUnique.mockResolvedValue({
      identifier: 'password-reset:user_1',
      expires: new Date(Date.now() - 60_000),
    })
    const { POST } = await import('./route')
    const response = await POST(request({ token: 'b'.repeat(43), password: 'new-password' }) as never)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid or expired password reset link' })
    expect(mocks.userUpdate).not.toHaveBeenCalled()
  })

  it('rejects a token that another request already consumed', async () => {
    mocks.tokenFindUnique.mockResolvedValue({
      identifier: 'password-reset:user_1',
      expires: new Date(Date.now() + 60_000),
    })
    mocks.tokenDeleteMany.mockResolvedValue({ count: 0 })
    const { POST } = await import('./route')
    const response = await POST(request({ token: 'c'.repeat(43), password: 'new-password' }) as never)

    expect(response.status).toBe(400)
    expect(mocks.userUpdate).not.toHaveBeenCalled()
  })
})
