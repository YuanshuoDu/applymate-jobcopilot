import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), validate: vi.fn(), grant: vi.fn(), mutation: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.validate }))
vi.mock('@/lib/admin/write-transaction', () => ({ runAdminMutation: mocks.mutation, AdminMutationConflict: class AdminMutationConflict extends Error {} }))
vi.mock('@/lib/db', () => ({ db: { adminBreakGlassGrant: { findUnique: mocks.grant } } }))

describe('POST /api/admin/v1/break-glass/:id/approve', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.requireAdmin.mockResolvedValue({ userId: 'approver', roleKey: 'security_admin', requestId: 'request' })
    mocks.validate.mockReturnValue(null)
    mocks.grant.mockResolvedValue({ requesterId: 'requester', expiresAt: new Date(Date.now() + 60_000), approverId: null, permission: 'support.read' })
    mocks.mutation.mockResolvedValue({ duplicate: false, value: { permission: 'support.read', expiresAt: new Date(Date.now() + 60_000) } })
  })

  it('delegates break-glass approval to the atomic admin mutation helper', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/admin/v1/break-glass/grant-1/approve', { method: 'POST', headers: { 'idempotency-key': 'key' }, body: JSON.stringify({ reason: 'Approve temporary support access after security review' }) }) as never, { params: Promise.resolve({ id: 'grant-1' }) })
    expect(response.status).toBe(200)
    expect(mocks.mutation).toHaveBeenCalledWith(expect.objectContaining({ action: 'break_glass.approved', idempotencyKey: 'key', targetId: 'grant-1' }))
  })
})
