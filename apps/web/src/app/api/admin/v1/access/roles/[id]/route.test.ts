import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(), findUnique: vi.fn(), update: vi.fn(), count: vi.fn(), audit: vi.fn(), idempotency: vi.fn(), mutation: vi.fn(), csrf: vi.fn(),
}))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/db', () => ({ db: { adminRole: { findUnique: mocks.findUnique, update: mocks.update }, adminMembership: { count: mocks.count } } }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: () => null }))
vi.mock('@/lib/admin/write-transaction', () => ({ runAdminMutation: mocks.mutation }))

describe('PATCH /api/admin/v1/access/roles/:id', () => {
  beforeEach(() => {
    vi.resetModules(); Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin_1', roleKey: 'security_admin', permissions: ['admin_roles.manage', 'users.read'] })
    mocks.csrf.mockReturnValue({ ok: true })
    mocks.findUnique.mockResolvedValue({ id: 'role_1', key: 'custom_ops', name: 'Custom Ops', permissions: ['users.read'], system: false, version: 1 })
    mocks.update.mockResolvedValue({ id: 'role_1', key: 'custom_ops', name: 'Operations Plus', permissions: ['users.read'], system: false, version: 2 })
    mocks.count.mockResolvedValue(1)
    mocks.mutation.mockImplementation(async (input: { mutate: (tx: unknown) => Promise<unknown>; audit: unknown }) => {
      const value = await input.mutate({ adminRole: { update: mocks.update } })
      mocks.audit(input.audit)
      return { duplicate: false, value }
    })
  })

  it('updates a role with optimistic versioning and audit', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/api/admin/v1/access/roles/role_1', {
      method: 'PATCH', headers: { Origin: 'http://localhost', 'Idempotency-Key': 'role-update-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Operations Plus', permissions: ['users.read'], version: 1, reason: 'Clarify support access' }),
    }) as never, { params: Promise.resolve({ id: 'role_1' }) })
    expect(response.status).toBe(200)
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'role_1' } }))
    expect(mocks.audit).toHaveBeenCalled()
  })
})
