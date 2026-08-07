import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: () => null }))
vi.mock('@/lib/db', () => ({ db: { platformFeatureFlag: { findUnique: mocks.findUnique, updateMany: mocks.updateMany } } }))

describe('POST /api/admin/v1/platform/flags/:id/approve', () => {
  beforeEach(() => { vi.resetModules(); Object.values(mocks).forEach((mock) => mock.mockReset()) })
  it('denies a creator from approving their own flag', async () => {
    mocks.requireAdmin.mockResolvedValue({ userId: 'creator-1', roleKey: 'platform_admin', requestId: 'request-1' })
    mocks.findUnique.mockResolvedValue({ createdById: 'creator-1' })
    const { POST } = await import('./route')
    const request = new Request('http://localhost/api/admin/v1/platform/flags/f1/approve', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key-1' }, body: JSON.stringify({ version: 2, reason: 'Approving reviewed platform feature flag' }) })
    const response = await POST(request as never, { params: Promise.resolve({ id: 'f1' }) })
    expect(response.status).toBe(403)
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })
})
