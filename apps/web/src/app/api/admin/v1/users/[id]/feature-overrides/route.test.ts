import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), userFind: vi.fn(), findMany: vi.fn(), upsert: vi.fn(), audit: vi.fn(), idempotency: vi.fn(), csrf: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.userFind }, userFeatureOverride: { findMany: mocks.findMany, upsert: mocks.upsert } } }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWriteRequest: mocks.csrf }))
vi.mock('@/lib/admin/idempotency', () => ({ withAdminIdempotency: mocks.idempotency }))

describe('feature override API', () => {
  beforeEach(() => {
    vi.resetModules(); Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin_1', roleKey: 'platform_admin', permissions: ['billing.update'] }); mocks.csrf.mockReturnValue({ ok: true })
    mocks.userFind.mockResolvedValue({ id: 'user_1' }); mocks.findMany.mockResolvedValue([{ id: 'override_1', featureKey: 'auto_apply', enabled: true, limit: null, expiresAt: null, reason: 'Pilot access', updatedAt: new Date('2026-08-03T00:00:00.000Z') }])
    mocks.upsert.mockResolvedValue({ id: 'override_1', featureKey: 'auto_apply', enabled: true, limit: null, expiresAt: null, reason: 'Pilot access', updatedAt: new Date('2026-08-03T00:00:00.000Z') })
    mocks.idempotency.mockImplementation(async (_db: unknown, _input: unknown, operation: (tx: unknown) => Promise<unknown>) => operation({ userFeatureOverride: { upsert: mocks.upsert }, adminAuditLog: { create: mocks.audit } }))
  })

  it('upserts a bounded override and never returns candidate data', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/api/admin/v1/users/user_1/feature-overrides', { method: 'PATCH', headers: { Origin: 'http://localhost', 'Idempotency-Key': 'override-1', 'Content-Type': 'application/json' }, body: JSON.stringify({ featureKey: 'auto_apply', enabled: true, reason: 'Enable pilot automation' }) }) as never, { params: Promise.resolve({ id: 'user_1' }) })
    expect(response.status).toBe(200)
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { userId_featureKey: { userId: 'user_1', featureKey: 'auto_apply' } } }))
    expect(JSON.stringify(await response.json())).not.toContain('password')
  })
})
