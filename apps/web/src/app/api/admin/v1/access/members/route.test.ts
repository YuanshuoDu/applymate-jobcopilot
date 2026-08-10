import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findMany: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/db', () => ({ db: { adminMembership: { findMany: mocks.findMany } } }))

describe('GET /api/admin/v1/access/members', () => {
  beforeEach(() => { vi.resetModules(); Object.values(mocks).forEach((mock) => mock.mockReset()) })
  it('returns masked member metadata without user secrets', async () => {
    mocks.requireAdmin.mockResolvedValue({ userId: 'security-1', roleKey: 'security_admin', requestId: 'request-1' })
    mocks.findMany.mockResolvedValue([{ id: 'member-1', status: 'active', mfaLevel: 'webauthn', sessionVersion: 1, grantedAt: new Date(), revokedAt: null, role: { key: 'support', name: 'Support' }, user: { id: 'staff-1', name: 'Staff', email: 'staff@example.com', plan: 'pro', location: 'Berlin', createdAt: new Date(), _count: { jobs: 0, resumes: 0, notifications: 0 }, gmailSyncState: null } }])
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/admin/v1/access/members') as never)
    const body = await response.json()
    expect(body.items[0].user.email).toBe('st***@example.com')
    expect(JSON.stringify(body)).not.toContain('password')
  })
})
