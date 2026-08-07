import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ admin: vi.fn(), findMany: vi.fn(), count: vi.fn(), dto: vi.fn() }))
vi.mock('@/lib/admin/settings-access', () => ({ requireSettingsAdmin: mocks.admin, toAdminSettingsDto: mocks.dto }))
vi.mock('@/lib/db', () => ({ db: { user: { findMany: mocks.findMany, count: mocks.count } } }))
vi.mock('@/lib/api-helpers', () => ({
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))

describe('GET /api/admin/v1/users', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.admin.mockReset(); mocks.findMany.mockReset(); mocks.count.mockReset(); mocks.dto.mockReset()
    mocks.admin.mockResolvedValue({ userId: 'admin_1', email: 'admin@example.com' })
    mocks.findMany.mockResolvedValue([{ id: 'user_1', email: 'candidate@example.com', plan: 'free', preferences: {} }])
    mocks.count.mockResolvedValue(1)
    mocks.dto.mockImplementation((user: unknown) => ({ id: (user as { id: string }).id }))
  })

  it('returns safe DTOs and no-store cache headers', async () => {
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/admin/v1/users') as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ users: [{ id: 'user_1' }], total: 1, page: 1, pageSize: 50 })
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({ id: true, email: true, preferences: true }),
    }))
  })
})
