import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), updateFind: vi.fn(), audit: vi.fn(), idempotency: vi.fn(), csrf: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.findUnique, updateMany: mocks.updateMany }, $transaction: mocks.idempotency } }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWriteRequest: mocks.csrf }))
vi.mock('@/lib/admin/idempotency', () => ({ withAdminIdempotency: mocks.idempotency }))

describe('PATCH /api/admin/v1/users/:id/account-state', () => {
  beforeEach(() => {
    vi.resetModules(); Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin_1', roleKey: 'platform_admin', permissions: ['users.suspend', 'users.restore'] })
    mocks.csrf.mockReturnValue({ ok: true })
    mocks.findUnique.mockResolvedValue({ id: 'user_1', plan: 'pro', accountStatus: 'active', updatedAt: new Date('2026-08-02T00:00:00.000Z') })
    mocks.updateMany.mockResolvedValue({ count: 1 })
    mocks.idempotency.mockImplementation(async (_db: unknown, _input: unknown, operation: (tx: unknown) => Promise<unknown>) => operation({ user: { updateMany: mocks.updateMany, findUnique: mocks.findUnique }, adminAuditLog: { create: mocks.audit } }))
  })

  it('suspends an account with an optimistic timestamp and audit', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/api/admin/v1/users/user_1/account-state', {
      method: 'PATCH', headers: { Origin: 'http://localhost', 'Idempotency-Key': 'state-update-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'suspended', updatedAt: '2026-08-02T00:00:00.000Z', reason: 'Policy review requires a pause' }),
    }) as never, { params: Promise.resolve({ id: 'user_1' }) })
    expect(response.status).toBe(200)
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'user_1', updatedAt: new Date('2026-08-02T00:00:00.000Z') } }))
    expect(mocks.audit).toHaveBeenCalled()
  })
})
