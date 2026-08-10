import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), snapshot: vi.fn(), audit: vi.fn(), queue: vi.fn() }))

vi.mock('@/lib/admin/authorization', () => ({
  requireAdmin: mocks.requireAdmin,
  isAdminResponse: (value: unknown) => value instanceof Response,
}))
vi.mock('@/lib/admin/observability', () => ({ getObservabilitySnapshot: mocks.snapshot }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/admin/queue-slo', () => ({ getQueueSloSnapshot: mocks.queue }))

describe('GET /api/admin/v1/observability', () => {
  beforeEach(() => { vi.resetModules(); mocks.requireAdmin.mockReset(); mocks.snapshot.mockReset(); mocks.audit.mockReset(); mocks.queue.mockReset(); mocks.queue.mockResolvedValue({ available: false, waiting: 0, active: 0, failed: 0, stuck: 0, deadLetter: 0 }) })

  it('requires observability.read before reading aggregates', async () => {
    mocks.requireAdmin.mockResolvedValue(new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }))
    const { GET } = await import('@/app/api/admin/v1/observability/route')
    const response = await GET(new Request('http://localhost/api/admin/v1/observability') as never)
    expect(response.status).toBe(403)
    expect(mocks.snapshot).not.toHaveBeenCalled()
  })

  it('returns no-store aggregates only for an authorized actor', async () => {
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1', roleKey: 'operations', requestId: 'request-1', permissions: ['observability.read'] })
    mocks.snapshot.mockResolvedValue({ overall: { total: 3 }, byAts: [] })
    const { GET } = await import('@/app/api/admin/v1/observability/route')
    const response = await GET(new Request('http://localhost/api/admin/v1/observability') as never)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ overall: { total: 3 }, byAts: [], queue: { available: false, waiting: 0, active: 0, failed: 0, stuck: 0, deadLetter: 0 } })
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'observability.viewed', actorUserId: 'admin-1' }))
  })
})
