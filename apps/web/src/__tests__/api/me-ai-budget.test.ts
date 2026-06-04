import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  queryRaw: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (val: unknown) => val instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))

vi.mock('@/lib/db', () => ({
  db: { $queryRaw: mocks.queryRaw },
}))

function request() {
  return new Request('http://localhost/api/me/ai-budget')
}

describe('GET /api/me/ai-budget', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset()
    mocks.queryRaw.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: 'user-1' })
  })

  it('returns used, limit, remaining, and hasBudget when a budget row exists', async () => {
    mocks.queryRaw.mockResolvedValueOnce([{ used: 18, limit: 30 }])
    const { GET } = await import('@/app/api/me/ai-budget/route')

    const res = await GET(request() as never)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      used: 18,
      limit: 30,
      remaining: 12,
      hasBudget: true,
    })
  })

  it('returns hasBudget false when the user has no budget row yet', async () => {
    mocks.queryRaw.mockResolvedValueOnce([])
    const { GET } = await import('@/app/api/me/ai-budget/route')

    const res = await GET(request() as never)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      used: 0,
      limit: 30,
      remaining: 30,
      hasBudget: false,
    })
  })

  it('returns auth errors without querying the budget table', async () => {
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }))
    const { GET } = await import('@/app/api/me/ai-budget/route')

    const res = await GET(request() as never)

    expect(res.status).toBe(401)
    expect(mocks.queryRaw).not.toHaveBeenCalled()
  })
})
