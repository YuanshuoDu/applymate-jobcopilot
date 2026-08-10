import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findUnique: vi.fn(), count: vi.fn(), updateMany: vi.fn(), update: vi.fn(), findMany: vi.fn(), createMany: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: () => null }))
vi.mock('@/lib/db', () => ({ db: { adminBroadcast: { findUnique: mocks.findUnique, updateMany: mocks.updateMany, update: mocks.update }, user: { count: mocks.count, findMany: mocks.findMany }, notification: { createMany: mocks.createMany } } }))

describe('POST /api/admin/v1/broadcasts/:id/publish', () => {
  beforeEach(() => { vi.resetModules(); Object.values(mocks).forEach((mock) => mock.mockReset()) })
  it('returns a completed idempotent publish without another delivery attempt', async () => {
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1', roleKey: 'platform_admin', requestId: 'request-1' })
    mocks.findUnique.mockResolvedValue({ status: 'published', publishIdempotencyKey: 'key-1' })
    const { POST } = await import('./route')
    const request = new Request('http://localhost/api/admin/v1/broadcasts/b1/publish', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key-1' }, body: JSON.stringify({ confirmation: 'publish', reason: 'Publishing approved maintenance announcement' }) })
    const response = await POST(request as never, { params: Promise.resolve({ id: 'b1' }) })
    await expect(response.json()).resolves.toEqual({ broadcast: { id: 'b1', status: 'published' }, duplicate: true })
    expect(mocks.createMany).not.toHaveBeenCalled()
  })
})
