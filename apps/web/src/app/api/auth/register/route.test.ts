import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  userFindMany: vi.fn(),
  userCreate: vi.fn(),
  hash: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    user: {
      findMany: mocks.userFindMany,
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
    mocks.userFindMany.mockResolvedValue([])
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
    expect(mocks.userFindMany).toHaveBeenCalledWith({
      where: { email: { equals: 'member@example.com', mode: 'insensitive' } },
      select: { id: true },
      take: 2,
    })
    expect(mocks.userCreate).toHaveBeenCalledWith({
      data: { email: 'member@example.com', name: 'Member', password: 'password-hash' },
      select: { id: true, email: true, name: true, plan: true, createdAt: true },
    })
  })

  it('prevents a case-variant from creating a second account', async () => {
    mocks.userFindMany.mockResolvedValue([{ id: 'existing-user' }])
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

  it('converts a database uniqueness race into the same safe conflict', async () => {
    mocks.userCreate.mockRejectedValue({ code: 'P2002' })
    const { POST } = await import('./route')
    const response = await POST(request({
      name: 'Member',
      email: 'member@example.com',
      password: 'password-123',
    }) as never)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'Email already registered' })
  })
})
