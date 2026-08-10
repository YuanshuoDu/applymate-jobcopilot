import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findMany: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/db', () => ({ db: { adminAuditLog: { findMany: mocks.findMany } } }))

describe('GET /api/admin/v1/audit', () => {
  beforeEach(() => { vi.resetModules(); mocks.requireAdmin.mockReset(); mocks.findMany.mockReset(); mocks.audit.mockReset() })
  it('selects event metadata without safe snapshots or request fingerprints', async () => {
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1', roleKey: 'security_admin', requestId: 'req-1' })
    mocks.findMany.mockResolvedValue([])
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/admin/v1/audit') as never)
    expect(response.status).toBe(200)
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ select: expect.not.objectContaining({ before: true, after: true, ipHash: true, userAgentHash: true }) }))
  })
})
