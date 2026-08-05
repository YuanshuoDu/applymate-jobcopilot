import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findUnique: vi.fn(), create: vi.fn(), idempotency: vi.fn(), auditLog: vi.fn(), transaction: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: vi.fn(), createAdminAuditData: (input: Record<string, unknown>) => input }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: () => null }))
vi.mock('@/lib/db', () => ({ db: { adminBroadcast: { findUnique: mocks.findUnique, create: mocks.create }, adminIdempotencyKey: { create: mocks.idempotency }, adminAuditLog: { create: mocks.auditLog }, $transaction: mocks.transaction } }))

describe('POST /api/admin/v1/broadcasts', () => {
  beforeEach(() => { vi.resetModules(); Object.values(mocks).forEach((mock) => mock.mockReset()) })
  it('creates an allow-listed draft after authorization and audit', async () => {
    mocks.requireAdmin.mockResolvedValue({ userId: 'operations-1', roleKey: 'operations', requestId: 'request-1' })
    mocks.findUnique.mockResolvedValue(null)
    mocks.create.mockResolvedValue({ id: 'broadcast-1', status: 'draft', createdAt: new Date() })
    mocks.idempotency.mockResolvedValue({ id: 'idem-1' })
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({ adminIdempotencyKey: { create: mocks.idempotency }, adminBroadcast: { create: mocks.create }, adminAuditLog: { create: mocks.auditLog } }))
    const { POST } = await import('./route')
    const request = new Request('http://localhost/api/admin/v1/broadcasts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key-1' }, body: JSON.stringify({ title: 'Maintenance', body: 'Scheduled maintenance this weekend.', audienceType: 'plan', audience: { plan: 'pro' }, reason: 'Creating maintenance announcement draft' }) })
    const response = await POST(request as never)
    expect(response.status).toBe(201)
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ audienceType: 'plan', createdById: 'operations-1' }) }))
    expect(mocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'broadcast.created' }) }))
  })
})
