import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findMany: vi.fn(), userFindMany: vi.fn(), roleFindUnique: vi.fn(), membershipFindUnique: vi.fn(), membershipCreate: vi.fn(), audit: vi.fn(), csrf: vi.fn(), mutation: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/db', () => ({ db: { user: { findMany: mocks.userFindMany }, adminRole: { findUnique: mocks.roleFindUnique }, adminMembership: { findMany: mocks.findMany, findUnique: mocks.membershipFindUnique, create: mocks.membershipCreate } } }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.csrf }))
vi.mock('@/lib/admin/write-transaction', () => ({ runAdminMutation: mocks.mutation }))

describe('GET /api/admin/v1/access/members', () => {
  beforeEach(() => { vi.resetModules(); Object.values(mocks).forEach((mock) => mock.mockReset()); mocks.csrf.mockReturnValue(null) })
  it('returns masked member metadata without user secrets', async () => {
    mocks.requireAdmin.mockResolvedValue({ userId: 'security-1', roleKey: 'security_admin', requestId: 'request-1' })
    mocks.findMany.mockResolvedValue([{ id: 'member-1', status: 'active', mfaLevel: 'webauthn', sessionVersion: 1, grantedAt: new Date(), revokedAt: null, role: { key: 'support', name: 'Support' }, user: { id: 'staff-1', name: 'Staff', email: 'staff@example.com', plan: 'pro', location: 'Berlin', createdAt: new Date(), _count: { jobs: 0, resumes: 0, notifications: 0 }, gmailSyncState: null } }])
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/admin/v1/access/members') as never)
    const body = await response.json()
    expect(body.items[0].user.email).toBe('st***@example.com')
    expect(JSON.stringify(body)).not.toContain('password')
  })

  it('resolves an administrator grant by normalized email without selecting a case variant arbitrarily', async () => {
    mocks.requireAdmin.mockResolvedValue({ userId: 'security-1', roleKey: 'security_admin', requestId: 'request-1' })
    mocks.userFindMany.mockResolvedValue([{ id: 'staff-1', name: 'Staff', email: 'Staff@Example.com' }])
    mocks.roleFindUnique.mockResolvedValue({ id: 'role-1', key: 'support', name: 'Support' })
    mocks.membershipFindUnique.mockResolvedValue(null)
    mocks.mutation.mockResolvedValue({ value: { id: 'membership-1', status: 'active', role: { key: 'support', name: 'Support' } } })
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/admin/v1/access/members', {
      method: 'POST',
      headers: { Origin: 'http://localhost', 'Idempotency-Key': 'grant-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ' STAFF@example.COM ', roleKey: 'support', reason: 'Grant support access for on-call coverage' }),
    }) as never)

    expect(response.status).toBe(201)
    expect(mocks.userFindMany).toHaveBeenCalledWith({
      where: { email: { equals: 'staff@example.com', mode: 'insensitive' } },
      take: 2,
      select: { id: true, email: true, name: true },
    })
  })
})
