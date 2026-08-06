import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findUnique: vi.fn(), idempotency: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin }))
vi.mock('@/lib/db', () => ({ db: { adminBroadcast: { findUnique: mocks.findUnique } } }))
vi.mock('@/lib/admin/idempotency', () => ({ withAdminIdempotency: mocks.idempotency }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))

describe('POST /api/admin/v1/broadcasts/:id/submit', () => {
  beforeEach(() => { vi.resetModules(); mocks.requireAdmin.mockReset().mockResolvedValue({ userId: 'admin-a', roleKey: 'operations' }); mocks.findUnique.mockReset(); mocks.idempotency.mockReset(); mocks.audit.mockReset() })

  it('allows the creator to submit a draft for separate approval', async () => {
    mocks.findUnique.mockResolvedValue({ id: 'broadcast-1', status: 'draft', createdById: 'admin-a' })
    mocks.idempotency.mockImplementation(async (_db: unknown, _input: unknown, operation: (tx: unknown) => Promise<unknown>) => operation({ adminBroadcast: { update: vi.fn().mockResolvedValue({ id: 'broadcast-1', status: 'pending_approval' }) } }))
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/admin/v1/broadcasts/broadcast-1/submit', { method: 'POST', headers: { Origin: 'http://localhost', 'Idempotency-Key': 'submit-key' }, body: JSON.stringify({ reason: 'Ready for a second administrator to review' }) }), { params: Promise.resolve({ id: 'broadcast-1' }) })
    expect(response.status).toBe(200)
    expect((await response.json()).broadcast.status).toBe('pending_approval')
  })
})
