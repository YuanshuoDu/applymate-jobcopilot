import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findMany: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin }))
vi.mock('@/lib/db', () => ({ db: { user: { findMany: mocks.findMany } } }))

describe('GET /api/admin/v1/users', () => {
  beforeEach(() => {
    vi.resetModules(); mocks.requireAdmin.mockReset(); mocks.findMany.mockReset()
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin_1', permissions: ['users.read'] })
    mocks.findMany.mockResolvedValue([{
      id: 'user_1', email: 'member@example.com', name: 'Member User', plan: 'pro', accountStatus: 'active', location: 'Berlin, Germany',
      createdAt: new Date('2026-08-01T00:00:00.000Z'), updatedAt: new Date('2026-08-02T00:00:00.000Z'), suspendedAt: null,
      _count: { resumes: 1, jobs: 3, applicationTasks: 2 }, password: 'hash', preferences: { aiSettings: { key: 'secret' } },
    }])
  })

  it('returns masked operational rows with a bounded select', async () => {
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/admin/v1/users?limit=100&q=member') as never)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const body = await response.json()
    expect(body.items[0]).toMatchObject({ email: 'm***@example.com', counts: { jobs: 3 } })
    expect(JSON.stringify(body)).not.toContain('secret')
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }))
    expect(mocks.findMany.mock.calls[0][0].select).not.toHaveProperty('password')
  })
})
