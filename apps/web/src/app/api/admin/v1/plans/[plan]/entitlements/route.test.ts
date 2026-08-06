import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), planFind: vi.fn(), planUpdate: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn(), audit: vi.fn(), idempotency: vi.fn(), csrf: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin }))
vi.mock('@/lib/db', () => ({ db: { planCatalog: { findUnique: mocks.planFind, update: mocks.planUpdate }, planEntitlement: { findMany: mocks.findMany, deleteMany: mocks.deleteMany, createMany: mocks.createMany } } }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWriteRequest: mocks.csrf }))
vi.mock('@/lib/admin/idempotency', () => ({ withAdminIdempotency: mocks.idempotency }))

describe('PATCH /api/admin/v1/plans/:plan/entitlements', () => {
  beforeEach(() => {
    vi.resetModules(); Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin_1', roleKey: 'billing', permissions: ['billing.update'] }); mocks.csrf.mockReturnValue({ ok: true })
    mocks.planFind.mockResolvedValue({ id: 'plan_1', plan: 'pro', version: 2 })
    mocks.planUpdate.mockResolvedValue({ id: 'plan_1', version: 3 })
    mocks.findMany.mockResolvedValue([{ id: 'ent_1', featureKey: 'auto_apply', kind: 'boolean', enabled: true }])
    mocks.idempotency.mockImplementation(async (_db: unknown, _input: unknown, operation: (tx: unknown) => Promise<unknown>) => operation({ planCatalog: { findUnique: mocks.planFind, update: mocks.planUpdate }, planEntitlement: { deleteMany: mocks.deleteMany, createMany: mocks.createMany, findMany: mocks.findMany }, adminAuditLog: { create: mocks.audit } }))
  })

  it('replaces entitlements atomically and audits the versioned change', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/api/admin/v1/plans/pro/entitlements', { method: 'PATCH', headers: { Origin: 'http://localhost', 'Idempotency-Key': 'entitlements-1', 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 2, entitlements: [{ featureKey: 'auto_apply', kind: 'boolean', enabled: true }], reason: 'Enable auto apply for Pro' }) }) as never, { params: Promise.resolve({ plan: 'pro' }) })
    expect(response.status).toBe(200)
    expect(mocks.deleteMany).toHaveBeenCalledWith({ where: { planId: 'plan_1' } })
    expect(mocks.createMany).toHaveBeenCalled()
    expect(mocks.audit).toHaveBeenCalled()
  })
})
