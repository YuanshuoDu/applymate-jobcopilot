import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findUnique: vi.fn(), transitionFind: vi.fn(), updateMany: vi.fn(), changeCreate: vi.fn(), userFind: vi.fn(), audit: vi.fn(), idempotency: vi.fn(), csrf: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin }))
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.findUnique, updateMany: mocks.updateMany }, planTransition: { findUnique: mocks.transitionFind }, userPlanChange: { create: mocks.changeCreate } } }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWriteRequest: mocks.csrf }))
vi.mock('@/lib/admin/idempotency', () => ({ withAdminIdempotency: mocks.idempotency }))

describe('PATCH /api/admin/v1/users/:id/plan', () => {
  beforeEach(() => {
    vi.resetModules(); Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin_1', roleKey: 'billing', permissions: ['billing.update'] }); mocks.csrf.mockReturnValue({ ok: true })
    mocks.findUnique.mockResolvedValue({ id: 'user_1', plan: 'free', accountStatus: 'active', updatedAt: new Date('2026-08-02T00:00:00.000Z') })
    mocks.transitionFind.mockResolvedValue({ id: 'transition_1', enabled: true, fromPlan: 'free', toPlan: 'pro' })
    mocks.updateMany.mockResolvedValue({ count: 1 }); mocks.changeCreate.mockResolvedValue({ id: 'change_1', fromPlan: 'free', toPlan: 'pro', createdAt: new Date('2026-08-03T00:00:00.000Z') })
    mocks.userFind.mockResolvedValue({ id: 'user_1', email: 'member@example.com', name: 'Member', plan: 'pro', accountStatus: 'active', location: 'Berlin, Germany', createdAt: new Date('2026-08-01T00:00:00.000Z'), updatedAt: new Date('2026-08-03T00:00:00.000Z'), suspendedAt: null, _count: { resumes: 1, jobs: 2, applicationTasks: 0 } })
    mocks.idempotency.mockImplementation(async (_db: unknown, _input: unknown, operation: (tx: unknown) => Promise<unknown>) => operation({ user: { updateMany: mocks.updateMany, findUnique: mocks.userFind }, userPlanChange: { create: mocks.changeCreate }, adminAuditLog: { create: mocks.audit } }))
  })

  it('changes a user plan only through an enabled transition and records history', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/api/admin/v1/users/user_1/plan', { method: 'PATCH', headers: { Origin: 'http://localhost', 'Idempotency-Key': 'manual-plan-1', 'Content-Type': 'application/json' }, body: JSON.stringify({ toPlan: 'pro', updatedAt: '2026-08-02T00:00:00.000Z', reason: 'Approved upgrade after support review' }) }) as never, { params: Promise.resolve({ id: 'user_1' }) })
    expect(response.status).toBe(200)
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { plan: 'pro' } }))
    expect(mocks.changeCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ fromPlan: 'free', toPlan: 'pro', actorUserId: 'admin_1' }) }))
    expect(mocks.audit).toHaveBeenCalled()
  })
})
