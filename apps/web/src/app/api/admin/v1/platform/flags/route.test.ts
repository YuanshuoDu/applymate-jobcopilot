import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findUnique: vi.fn(), create: vi.fn(), audit: vi.fn(), mutation: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/admin/write-transaction', () => ({ runAdminMutation: mocks.mutation }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: () => null }))
vi.mock('@/lib/db', () => ({ db: { platformFeatureFlag: { findUnique: mocks.findUnique, create: mocks.create } } }))

describe('POST /api/admin/v1/platform/flags', () => {
  beforeEach(() => { vi.resetModules(); Object.values(mocks).forEach((mock) => mock.mockReset()) })
  it('creates a constrained draft with an audit event', async () => {
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1', roleKey: 'platform_admin', requestId: 'request-1' })
    mocks.findUnique.mockResolvedValue(null)
    mocks.mutation.mockResolvedValue({ duplicate: false, value: { id: 'flag-1' } })
    mocks.create.mockResolvedValue({ id: 'flag-1', key: 'worker_discovery', environment: 'development', enabled: false, rolloutPercent: 0, targetPlans: [], targetUserIds: [], status: 'draft', version: 1, createdById: 'admin-1', approvedById: null, rollbackAt: null, updatedAt: new Date() })
    const { POST } = await import('./route')
    const request = new Request('http://localhost/api/admin/v1/platform/flags', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key-1' }, body: JSON.stringify({ key: 'worker_discovery', environment: 'development', enabled: false, rolloutPercent: 0, targetPlans: [], targetUserIds: [], reason: 'Creating reviewed platform feature flag draft' }) })
    const response = await POST(request as never)
    expect(response.status).toBe(201)
    expect(mocks.mutation).toHaveBeenCalled()
  })

  it('rejects an unregistered control before creating a draft', async () => {
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1', roleKey: 'platform_admin', requestId: 'request-1' })
    const { POST } = await import('./route')
    const request = new Request('http://localhost/api/admin/v1/platform/flags', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key-1' }, body: JSON.stringify({ key: 'new_feature', environment: 'development', enabled: false, rolloutPercent: 0, targetPlans: [], targetUserIds: [], reason: 'Creating reviewed platform feature flag draft' }) })

    const response = await POST(request as never)

    expect(response.status).toBe(400)
    expect(mocks.mutation).not.toHaveBeenCalled()
  })
})
