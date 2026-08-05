import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), updateMany: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: () => null }))
vi.mock('@/lib/db', () => ({ db: { adminBroadcast: { updateMany: mocks.updateMany } } }))

describe('POST /api/admin/v1/broadcasts/:id/cancel', () => {
  beforeEach(() => { vi.resetModules(); Object.values(mocks).forEach((mock) => mock.mockReset()) })
  it('never cancels a broadcast that is already being delivered or published', async () => {
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1', roleKey: 'platform_admin', requestId: 'request-1' })
    mocks.updateMany.mockResolvedValue({ count: 0 })
    const { POST } = await import('./route')
    const request = new Request('http://localhost/api/admin/v1/broadcasts/b1/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key-1' }, body: JSON.stringify({ reason: 'Cancelling duplicate planned announcement' }) })
    const response = await POST(request as never, { params: Promise.resolve({ id: 'b1' }) })
    expect(response.status).toBe(409)
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: { in: ['draft', 'pending_approval', 'scheduled'] } }) }))
  })
})
