import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userCreate: vi.fn(),
  hash: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    user: {
      findUnique: mocks.userFindUnique,
      create: mocks.userCreate,
    },
  },
}))

vi.mock('bcryptjs', () => ({
  default: { hash: mocks.hash },
}))

vi.mock('@/lib/api-helpers', () => ({
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))

function request(body: unknown) {
  return new Request('http://localhost:3000/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('register API', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.userFindUnique.mockResolvedValue(null)
    mocks.hash.mockResolvedValue('password-hash')
    mocks.userCreate.mockResolvedValue({
      id: 'user_1',
      email: 'member@example.com',
      name: 'Member',
      plan: 'free',
      createdAt: new Date('2026-07-26T00:00:00.000Z'),
    })
  })

  it('normalizes an email before checking and creating the account', async () => {
    const { POST } = await import('./route')
    const response = await POST(request({
      name: 'Member',
      email: '  Member@Example.COM ',
      password: 'password-123',
    }) as never)

    expect(response.status).toBe(201)
    expect(mocks.userFindUnique).toHaveBeenCalledWith({ where: { email: 'member@example.com' } })
    expect(mocks.userCreate).toHaveBeenCalledWith({
      data: { email: 'member@example.com', name: 'Member', password: 'password-hash' },
      select: { id: true, email: true, name: true, plan: true, createdAt: true },
    })
  })

  it('prevents a case-variant from creating a second account', async () => {
    mocks.userFindUnique.mockResolvedValue({ id: 'existing-user' })
    const { POST } = await import('./route')
    const response = await POST(request({
      name: 'Member',
      email: 'MEMBER@EXAMPLE.COM',
      password: 'password-123',
    }) as never)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'Email already registered' })
    expect(mocks.userCreate).not.toHaveBeenCalled()
  })
})
