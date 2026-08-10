import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), audit: vi.fn(), mutation: vi.fn(), csrf: vi.fn(),
}))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/db', () => ({ db: { adminMembership: { findUnique: mocks.findUnique }, adminRole: { findUnique: mocks.findUnique } } }))
vi.mock('@/lib/admin/write-transaction', () => ({ runAdminMutation: mocks.mutation }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.csrf }))

describe('PATCH /api/admin/v1/access/members/:id', () => {
  beforeEach(() => {
    vi.resetModules(); Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin_1', roleKey: 'security_admin', permissions: ['admin_members.manage', 'admin_roles.manage'] })
    mocks.csrf.mockReturnValue(null)
    mocks.findUnique.mockImplementation(async (input: { where?: { id?: string; key?: string } }) => input.where?.id ? { userId: 'user_1' } : { id: 'role_2' })
    mocks.updateMany.mockResolvedValue({ count: 1 })
    mocks.mutation.mockImplementation(async (input: { mutate: (tx: unknown) => Promise<unknown>; audit: unknown }) => { const value = await input.mutate({ adminMembership: { updateMany: mocks.updateMany } }); mocks.audit(input.audit); return { duplicate: false, value } })
  })

  it('changes role/status with an optimistic version and audit', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/api/admin/v1/access/members/membership_1', {
      method: 'PATCH', headers: { Origin: 'http://localhost', 'Idempotency-Key': 'member-update-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleKey: 'operations', status: 'suspended', sessionVersion: 1, reason: 'Temporarily pause access' }),
    }) as never, { params: Promise.resolve({ id: 'membership_1' }) })
    expect(response.status).toBe(200)
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'membership_1', sessionVersion: 1 } }))
    expect(mocks.audit).toHaveBeenCalled()
  })
})
