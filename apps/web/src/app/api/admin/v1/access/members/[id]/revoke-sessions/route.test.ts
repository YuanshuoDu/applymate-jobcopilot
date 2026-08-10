import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), updateMany: vi.fn(), audit: vi.fn(), mutation: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/admin/write-transaction', () => ({ runAdminMutation: mocks.mutation }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: () => null }))
vi.mock('@/lib/db', () => ({ db: { adminMembership: { updateMany: mocks.updateMany } } }))

describe('POST /api/admin/v1/access/members/:id/revoke-sessions', () => {
  beforeEach(() => { vi.resetModules(); Object.values(mocks).forEach((mock) => mock.mockReset()) })
  it('refuses a stale session-version mutation', async () => {
    mocks.requireAdmin.mockResolvedValue({ userId: 'security-1', roleKey: 'security_admin', requestId: 'request-1' })
    mocks.updateMany.mockResolvedValue({ count: 0 })
    mocks.mutation.mockResolvedValue({ duplicate: false, value: { count: 0 } })
    const { POST } = await import('./route')
    const request = new Request('http://localhost/api/admin/v1/access/members/member-1/revoke-sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key-1' }, body: JSON.stringify({ sessionVersion: 1, reason: 'Revoking active internal sessions for security review' }) })
    const response = await POST(request as never, { params: Promise.resolve({ id: 'member-1' }) })
    expect(response.status).toBe(409)
    expect(mocks.audit).not.toHaveBeenCalled()
  })
})
