import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(), findUnique: vi.fn(), update: vi.fn(), roleFindUnique: vi.fn(), count: vi.fn(), audit: vi.fn(), idempotency: vi.fn(), csrf: vi.fn(),
}))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin }))
vi.mock('@/lib/db', () => ({ db: { adminMembership: { findUnique: mocks.findUnique, update: mocks.update, count: mocks.count }, adminRole: { findUnique: mocks.roleFindUnique } } }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWriteRequest: mocks.csrf }))
vi.mock('@/lib/admin/idempotency', () => ({ withAdminIdempotency: mocks.idempotency }))

describe('PATCH /api/admin/v1/access/members/:id', () => {
  beforeEach(() => {
    vi.resetModules(); Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin_1', roleKey: 'security_admin', permissions: ['admin_members.manage', 'admin_roles.manage'] })
    mocks.csrf.mockReturnValue({ ok: true })
    mocks.findUnique.mockResolvedValue({ id: 'membership_1', userId: 'user_1', roleId: 'role_1', status: 'active', mfaLevel: 'none', sessionVersion: 1, grantedAt: new Date('2026-08-01T00:00:00.000Z'), role: { id: 'role_1', key: 'support', name: 'Support', permissions: ['users.read'] }, user: { id: 'user_1', email: 'user@example.com', name: 'User', plan: 'free' } })
    mocks.roleFindUnique.mockResolvedValue({ id: 'role_2', key: 'operations', name: 'Operations', permissions: ['users.read'], system: true, version: 1 })
    mocks.update.mockResolvedValue({ id: 'membership_1', userId: 'user_1', roleId: 'role_2', status: 'suspended', mfaLevel: 'none', sessionVersion: 1, grantedAt: new Date('2026-08-01T00:00:00.000Z'), role: { key: 'operations', name: 'Operations', permissions: ['users.read'] }, user: { id: 'user_1', email: 'user@example.com', name: 'User', plan: 'free' } })
    mocks.idempotency.mockImplementation(async (_db: unknown, _input: unknown, operation: (tx: unknown) => Promise<unknown>) => operation({ adminMembership: { update: mocks.update }, adminAuditLog: { create: mocks.audit } }))
  })

  it('changes role/status with an optimistic version and audit', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/api/admin/v1/access/members/membership_1', {
      method: 'PATCH', headers: { Origin: 'http://localhost', 'Idempotency-Key': 'member-update-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleId: 'role_2', status: 'suspended', version: 1, reason: 'Temporarily pause access' }),
    }) as never, { params: Promise.resolve({ id: 'membership_1' }) })
    expect(response.status).toBe(200)
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'membership_1', sessionVersion: 1 } }))
    expect(mocks.audit).toHaveBeenCalled()
  })
})
