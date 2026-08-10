import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(), findUnique: vi.fn(), update: vi.fn(), count: vi.fn(), audit: vi.fn(), idempotency: vi.fn(), csrf: vi.fn(),
}))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/db', () => ({ db: { adminRole: { findUnique: mocks.findUnique, update: mocks.update }, adminMembership: { count: mocks.count } } }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWriteRequest: mocks.csrf }))
vi.mock('@/lib/admin/idempotency', () => ({ withAdminIdempotency: mocks.idempotency }))

describe('PATCH /api/admin/v1/access/roles/:id', () => {
  beforeEach(() => {
    vi.resetModules(); Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin_1', roleKey: 'security_admin', permissions: ['admin_roles.manage', 'users.read'] })
    mocks.csrf.mockReturnValue({ ok: true })
    mocks.findUnique.mockResolvedValue({ id: 'role_1', key: 'custom_ops', name: 'Custom Ops', permissions: ['users.read'], system: false, version: 1 })
    mocks.update.mockResolvedValue({ id: 'role_1', key: 'custom_ops', name: 'Operations Plus', permissions: ['users.read'], system: false, version: 2 })
    mocks.count.mockResolvedValue(1)
    mocks.idempotency.mockImplementation(async (_db: unknown, _input: unknown, operation: (tx: unknown) => Promise<unknown>) => operation({ adminRole: { update: mocks.update }, adminAuditLog: { create: mocks.audit } }))
  })

  it('updates a role with optimistic versioning and audit', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/api/admin/v1/access/roles/role_1', {
      method: 'PATCH', headers: { Origin: 'http://localhost', 'Idempotency-Key': 'role-update-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Operations Plus', permissions: ['users.read'], version: 1, reason: 'Clarify support access' }),
    }) as never, { params: Promise.resolve({ id: 'role_1' }) })
    expect(response.status).toBe(200)
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'role_1', version: 1 } }))
    expect(mocks.audit).toHaveBeenCalled()
  })
})
