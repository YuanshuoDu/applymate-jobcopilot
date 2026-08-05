import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findUnique: vi.fn(), update: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: () => null }))
vi.mock('@/lib/db', () => ({ db: { adminBroadcast: { findUnique: mocks.findUnique, update: mocks.update } } }))

describe('POST /api/admin/v1/broadcasts/:id/approve', () => {
  beforeEach(() => { vi.resetModules(); Object.values(mocks).forEach((mock) => mock.mockReset()) })
  it('rejects self-approval before mutating the broadcast', async () => {
    mocks.requireAdmin.mockResolvedValue({ userId: 'creator-1', roleKey: 'platform_admin', requestId: 'request-1' })
    mocks.findUnique.mockResolvedValue({ createdById: 'creator-1', approvedById: null, status: 'draft' })
    const { POST } = await import('./route')
    const request = new Request('http://localhost/api/admin/v1/broadcasts/b1/approve', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key-1' }, body: JSON.stringify({ reason: 'Approving reviewed maintenance announcement' }) })
    const response = await POST(request as never, { params: Promise.resolve({ id: 'b1' }) })
    expect(response.status).toBe(403)
    expect(mocks.update).not.toHaveBeenCalled()
  })
})
