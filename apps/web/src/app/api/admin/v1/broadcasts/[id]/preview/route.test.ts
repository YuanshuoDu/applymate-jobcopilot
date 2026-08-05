import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findUnique: vi.fn(), count: vi.fn(), groupBy: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/db', () => ({ db: { adminBroadcast: { findUnique: mocks.findUnique }, user: { count: mocks.count, groupBy: mocks.groupBy } } }))

describe('POST /api/admin/v1/broadcasts/:id/preview', () => {
  beforeEach(() => { vi.resetModules(); Object.values(mocks).forEach((mock) => mock.mockReset()) })
  it('returns only anonymous counts meeting the k-anonymity threshold', async () => {
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1', roleKey: 'operations', requestId: 'request-1' })
    mocks.findUnique.mockResolvedValue({ audienceType: 'plan', audience: { plan: 'pro' } })
    mocks.count.mockResolvedValue(24)
    mocks.groupBy.mockResolvedValue([{ plan: 'pro', _count: { _all: 24 } }, { plan: 'free', _count: { _all: 4 } }])
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/admin/v1/broadcasts/b1/preview', { method: 'POST' }) as never, { params: Promise.resolve({ id: 'b1' }) })
    await expect(response.json()).resolves.toEqual({ recipientCount: 24, byPlan: [{ plan: 'pro', count: 24 }] })
  })
})
