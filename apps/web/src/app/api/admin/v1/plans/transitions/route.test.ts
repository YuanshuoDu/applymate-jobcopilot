import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findMany: vi.fn(), upsert: vi.fn(), audit: vi.fn(), idempotency: vi.fn(), csrf: vi.fn(), active: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin }))
vi.mock('@/lib/db', () => ({ db: { planCatalog: { findMany: mocks.active }, planTransition: { findMany: mocks.findMany, upsert: mocks.upsert } } }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWriteRequest: mocks.csrf }))
vi.mock('@/lib/admin/idempotency', () => ({ withAdminIdempotency: mocks.idempotency }))

describe('PATCH /api/admin/v1/plans/transitions', () => {
  beforeEach(() => {
    vi.resetModules(); Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin_1', roleKey: 'billing', permissions: ['billing.update'] }); mocks.csrf.mockReturnValue({ ok: true })
    mocks.active.mockResolvedValue([{ plan: 'free', active: true }, { plan: 'pro', active: true }, { plan: 'enterprise', active: false }])
    mocks.findMany.mockResolvedValue([]); mocks.upsert.mockResolvedValue({ id: 'transition_1', fromPlan: 'free', toPlan: 'pro', enabled: true, note: null, version: 1 })
    mocks.idempotency.mockImplementation(async (_db: unknown, _input: unknown, operation: (tx: unknown) => Promise<unknown>) => operation({ planTransition: { upsert: mocks.upsert }, adminAuditLog: { create: mocks.audit } }))
  })

  it('refuses an enabled transition to an inactive plan', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/api/admin/v1/plans/transitions', { method: 'PATCH', headers: { Origin: 'http://localhost', 'Idempotency-Key': 'transition-1', 'Content-Type': 'application/json' }, body: JSON.stringify({ fromPlan: 'free', toPlan: 'enterprise', enabled: true, reason: 'Attempt invalid transition' }) }) as never)
    expect(response.status).toBe(400)
    expect(mocks.upsert).not.toHaveBeenCalled()
  })
})
