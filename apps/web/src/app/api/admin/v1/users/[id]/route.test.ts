import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findUnique: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin }))
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.findUnique } } }))

describe('GET /api/admin/v1/users/:id', () => {
  beforeEach(() => {
    vi.resetModules(); mocks.requireAdmin.mockReset(); mocks.findUnique.mockReset()
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin_1', permissions: ['users.read'] })
    mocks.findUnique.mockResolvedValue({
      id: 'user_1', email: 'member@example.com', name: 'Member User', plan: 'free', accountStatus: 'suspended', location: 'Dublin, Ireland',
      createdAt: new Date('2026-08-01T00:00:00.000Z'), updatedAt: new Date('2026-08-02T00:00:00.000Z'), suspendedAt: new Date('2026-08-02T00:00:00.000Z'),
      _count: { resumes: 0, jobs: 0, applicationTasks: 0 }, planChanges: [{ id: 'change_1', fromPlan: 'free', toPlan: 'pro', createdAt: new Date('2026-08-01T00:00:00.000Z') }],
    })
  })

  it('returns detail metadata and plan history without candidate content', async () => {
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/admin/v1/users/user_1') as never, { params: Promise.resolve({ id: 'user_1' }) })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ user: { region: 'Ireland', accountStatus: 'suspended' }, planChanges: [{ toPlan: 'pro' }] })
    expect(JSON.stringify(body)).not.toContain('content')
  })
})
