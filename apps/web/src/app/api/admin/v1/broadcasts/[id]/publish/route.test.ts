import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findUnique: vi.fn(), idempotency: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin }))
vi.mock('@/lib/db', () => ({ db: { adminBroadcast: { findUnique: mocks.findUnique } } }))
vi.mock('@/lib/admin/idempotency', () => ({ withAdminIdempotency: mocks.idempotency }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))

describe('POST /api/admin/v1/broadcasts/:id/publish', () => {
  beforeEach(() => { vi.resetModules(); mocks.requireAdmin.mockReset(); mocks.findUnique.mockReset(); mocks.idempotency.mockReset(); mocks.audit.mockReset(); mocks.requireAdmin.mockResolvedValue({ userId: 'admin-a', roleKey: 'platform_admin' }) })

  it('prevents the creator from publishing their own broadcast', async () => {
    mocks.findUnique.mockResolvedValue({ id: 'broadcast-1', status: 'scheduled', createdById: 'admin-a', audienceType: 'all_active_users', audience: {}, title: 'Update', body: 'Text' })
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/admin/v1/broadcasts/broadcast-1/publish', { method: 'POST', headers: { Origin: 'http://localhost', 'Idempotency-Key': 'publish-key' }, body: JSON.stringify({ reason: 'Publishing requires a second administrator', confirm: true }) }), { params: Promise.resolve({ id: 'broadcast-1' }) })
    expect(response.status).toBe(403)
    expect((await response.json()).error).toBe('BROADCAST_CREATOR_CANNOT_PUBLISH')
    expect(mocks.idempotency).not.toHaveBeenCalled()
  })
})
