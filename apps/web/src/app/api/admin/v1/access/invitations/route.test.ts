import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), role: vi.fn(), run: vi.fn(), validate: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: vi.fn() }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.validate }))
vi.mock('@/lib/db', () => ({ db: { adminRole: { findUnique: mocks.role }, adminInvitation: { findMany: vi.fn() } } }))
vi.mock('@/lib/admin/write-transaction', () => ({ runAdminMutation: mocks.run }))

describe('POST /api/admin/v1/access/invitations', () => {
  beforeEach(() => { mocks.requireAdmin.mockReset(); mocks.role.mockReset(); mocks.run.mockReset(); mocks.validate.mockReset(); mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1', roleKey: 'security_admin', requestId: 'req-1' }); mocks.validate.mockReturnValue(null); mocks.role.mockResolvedValue({ id: 'role-1', key: 'operations', name: 'Operations' }); mocks.run.mockImplementation(async (input: { mutate: (tx: unknown) => Promise<unknown> }) => ({ duplicate: false, value: await input.mutate({ adminInvitation: { create: vi.fn().mockResolvedValue({ id: 'inv-1', email: 'new@example.com', expiresAt: new Date(), role: { key: 'operations', name: 'Operations' } }) } }) })) })

  it('creates a hashed, expiring invitation and returns a one-time URL', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/admin/v1/access/invitations', { method: 'POST', headers: { Origin: 'http://localhost', Host: 'localhost', 'Idempotency-Key': 'invite-1', 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'new@example.com', roleKey: 'operations', reason: 'Invite the on-call operations administrator' }) }) as never)
    const payload = await response.json()
    expect(response.status).toBe(201)
    expect(payload.inviteUrl).toContain('/invite/admin?token=')
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin_invitation.created', idempotencyKey: 'invite-1' }))
  })
})
