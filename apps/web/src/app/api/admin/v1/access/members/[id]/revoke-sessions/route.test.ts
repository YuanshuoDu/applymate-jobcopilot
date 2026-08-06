import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(), findUnique: vi.fn(), update: vi.fn(), audit: vi.fn(), idempotency: vi.fn(), csrf: vi.fn(),
}))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin }))
vi.mock('@/lib/db', () => ({ db: { adminMembership: { findUnique: mocks.findUnique, update: mocks.update } } }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWriteRequest: mocks.csrf }))
vi.mock('@/lib/admin/idempotency', () => ({ withAdminIdempotency: mocks.idempotency }))

describe('POST /api/admin/v1/access/members/:id/revoke-sessions', () => {
  beforeEach(() => {
    vi.resetModules(); Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin_1', permissions: ['sessions.revoke'] })
    mocks.csrf.mockReturnValue({ ok: true })
    mocks.findUnique.mockResolvedValue({ id: 'membership_1', userId: 'user_1', sessionVersion: 3, role: { key: 'support' } })
    mocks.update.mockResolvedValue({ id: 'membership_1', sessionVersion: 4 })
    mocks.idempotency.mockImplementation(async (_db: unknown, _input: unknown, operation: (tx: unknown) => Promise<unknown>) => operation({ adminMembership: { update: mocks.update }, adminAuditLog: { create: mocks.audit } }))
  })

  it('increments the membership session version atomically', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/admin/v1/access/members/membership_1/revoke-sessions', {
      method: 'POST', headers: { Origin: 'http://localhost', 'Idempotency-Key': 'revoke-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Immediate security response' }),
    }) as never, { params: Promise.resolve({ id: 'membership_1' }) })
    expect(response.status).toBe(200)
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: { sessionVersion: { increment: 1 } } }))
    expect(response.headers.get('x-request-id')).toBeTruthy()
  })
})
