import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  writeAdminAudit: vi.fn(),
  broadcastFindMany: vi.fn(),
  membershipFindMany: vi.fn(),
}))

vi.mock('@/lib/admin/authorization', () => ({
  requireAdmin: mocks.requireAdmin,
  isAdminResponse: (value: unknown) => value instanceof Response,
}))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.writeAdminAudit }))
vi.mock('@/lib/db', () => ({ db: {
  adminBroadcast: { findMany: mocks.broadcastFindMany },
  adminMembership: { findMany: mocks.membershipFindMany },
} }))

describe('GET /api/admin/v1/export', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin_1', roleKey: 'ops', requestId: 'req_1' })
    mocks.writeAdminAudit.mockResolvedValue(undefined)
    vi.stubEnv('ADMIN_EXPORT_SALT', 'test-export-salt')
    vi.stubEnv('NEXTAUTH_SECRET', 'test-nextauth-secret')
  })

  it('exports broadcasts with a title search without applying text operators to enum status', async () => {
    mocks.broadcastFindMany.mockResolvedValue([{ id: 'b1', title: 'Maintenance', audienceType: 'all_active_users', status: 'draft', scheduledAt: null, recipientCount: 0, deliveredCount: 0, failedCount: 0, createdAt: new Date('2026-08-10T00:00:00.000Z') }])
    const { GET } = await import('./route')
    const response = await GET(new NextRequest('http://localhost/api/admin/v1/export?resource=broadcasts&q=maint'))

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Maintenance')
    expect(mocks.broadcastFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { title: { contains: 'maint', mode: 'insensitive' } } }))
  })

  it('fails closed for anonymized access exports when no export salt is configured', async () => {
    vi.stubEnv('ADMIN_EXPORT_SALT', '')
    vi.stubEnv('NEXTAUTH_SECRET', '')
    const { GET } = await import('./route')
    const response = await GET(new NextRequest('http://localhost/api/admin/v1/export?resource=access-members'))

    expect(response.status).toBe(503)
    expect(mocks.membershipFindMany).not.toHaveBeenCalled()
  })
})
