import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn(), count: vi.fn(), audit: vi.fn(), idempotency: vi.fn(), csrf: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/db', () => ({ db: { planCatalogue: { findUnique: mocks.findUnique, updateMany: mocks.updateMany, findUniqueOrThrow: mocks.findUniqueOrThrow }, planTransition: { count: mocks.count } } }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWriteRequest: mocks.csrf }))
vi.mock('@/lib/admin/idempotency', () => ({ withAdminIdempotency: mocks.idempotency }))

describe('PATCH /api/admin/v1/plans/:plan', () => {
  beforeEach(() => {
    vi.resetModules(); Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin_1', roleKey: 'billing', permissions: ['billing.update'] })
    mocks.csrf.mockReturnValue({ ok: true }); mocks.count.mockResolvedValue(0)
    mocks.findUnique.mockResolvedValue({ id: 'plan_1', plan: 'pro', name: 'Pro', description: 'Old', priceMinor: 1900, currency: 'EUR', interval: 'month', features: [], entitlements: [], badge: null, cta: 'Upgrade', trialDays: 0, active: true, sortOrder: 1, version: 1 })
    mocks.updateMany.mockResolvedValue({ count: 1 })
    mocks.findUniqueOrThrow.mockResolvedValue({ id: 'plan_1', plan: 'pro', name: 'Pro Plus', description: 'New', priceMinor: 2000, currency: 'EUR', interval: 'month', features: [], entitlements: [], badge: null, cta: 'Upgrade', trialDays: 0, active: true, sortOrder: 1, version: 2 })
    mocks.idempotency.mockImplementation(async (_db: unknown, _input: unknown, operation: (tx: unknown) => Promise<unknown>) => operation({ planCatalogue: { updateMany: mocks.updateMany, findUniqueOrThrow: mocks.findUniqueOrThrow } }))
  })

  it('updates catalogue metadata with optimistic versioning', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/api/admin/v1/plans/pro', { method: 'PATCH', headers: { Origin: 'http://localhost', 'Idempotency-Key': 'plan-update-1', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Pro Plus', monthlyPriceCents: 2000, yearlyPriceCents: 20000, currency: 'EUR', active: true, version: 1, reason: 'Adjust plan pricing' }) }) as never, { params: Promise.resolve({ plan: 'pro' }) })
    expect(response.status).toBe(200)
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'plan_1', version: 1 } }))
    expect(mocks.audit).toHaveBeenCalled()
  })
})
