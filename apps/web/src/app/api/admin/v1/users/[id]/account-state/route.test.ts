import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), membershipUpdateMany: vi.fn(), automationUpdateMany: vi.fn(), taskUpdateMany: vi.fn(), audit: vi.fn(), idempotency: vi.fn(), mutation: vi.fn(), csrf: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.findUnique, updateMany: mocks.updateMany }, $transaction: mocks.idempotency } }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: () => null }))
vi.mock('@/lib/admin/write-transaction', () => ({ runAdminMutation: mocks.mutation }))

describe('PATCH /api/admin/v1/users/:id/account-state', () => {
  beforeEach(() => {
    vi.resetModules(); Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin_1', roleKey: 'platform_admin', permissions: ['users.suspend', 'users.restore'] })
    mocks.csrf.mockReturnValue({ ok: true })
    mocks.findUnique.mockResolvedValue({ id: 'user_1', accountStatus: 'active', suspendedAt: null, suspensionReason: null })
    mocks.update.mockResolvedValue({ id: 'user_1', name: 'Test User', email: 'test@example.com', plan: 'pro', accountStatus: 'suspended', location: 'Dublin', createdAt: new Date('2026-08-02T00:00:00.000Z'), _count: { jobs: 0, resumes: 0, notifications: 0 }, gmailSyncState: null })
    mocks.updateMany.mockResolvedValue({ count: 1 }); mocks.membershipUpdateMany.mockResolvedValue({ count: 1 }); mocks.automationUpdateMany.mockResolvedValue({ count: 1 }); mocks.taskUpdateMany.mockResolvedValue({ count: 1 })
    mocks.mutation.mockImplementation(async (input: { mutate: (tx: unknown) => Promise<unknown>; audit: unknown }) => {
      const value = await input.mutate({ user: { update: mocks.update }, adminMembership: { updateMany: mocks.membershipUpdateMany }, agentAutomation: { updateMany: mocks.automationUpdateMany }, applicationTask: { updateMany: mocks.taskUpdateMany } })
      mocks.audit(input.audit)
      return { duplicate: false, value }
    })
  })

  it('suspends an account with an optimistic timestamp and audit', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/api/admin/v1/users/user_1/account-state', {
      method: 'PATCH', headers: { Origin: 'http://localhost', 'Idempotency-Key': 'state-update-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'suspended', reason: 'Policy review requires a pause' }),
    }) as never, { params: Promise.resolve({ id: 'user_1' }) })
    expect(response.status).toBe(200)
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'user_1' }, data: expect.objectContaining({ accountStatus: 'suspended' }) }))
    expect(mocks.audit).toHaveBeenCalled()
  })
})
