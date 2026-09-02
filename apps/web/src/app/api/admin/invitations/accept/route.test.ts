import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ safeAuth: vi.fn(), userFindUnique: vi.fn(), invitationFindUnique: vi.fn(), membershipFindUnique: vi.fn(), transaction: vi.fn() }))

vi.mock('@/lib/safe-auth', () => ({ safeAuth: mocks.safeAuth }))
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.userFindUnique }, adminInvitation: { findUnique: mocks.invitationFindUnique }, adminMembership: { findUnique: mocks.membershipFindUnique }, $transaction: mocks.transaction } }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: vi.fn() }))

describe('POST /api/admin/invitations/accept', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.safeAuth.mockReset()
    mocks.userFindUnique.mockReset()
    mocks.invitationFindUnique.mockReset()
    mocks.membershipFindUnique.mockReset()
    mocks.transaction.mockReset()
  })

  it('rejects invitation acceptance on the public application host before reading a session', async () => {
    const { POST } = await import('./route')
    const response = await POST(new NextRequest('https://applymate.site/api/admin/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token: 'a'.repeat(20) }),
    }))

    expect(response.status).toBe(404)
    expect(mocks.safeAuth).not.toHaveBeenCalled()
  })

  it('rejects invitation acceptance for a suspended account', async () => {
    mocks.safeAuth.mockResolvedValue({ user: { id: 'user_1', email: 'admin@example.com', authVersion: 1 } })
    mocks.userFindUnique.mockResolvedValue({ email: 'admin@example.com', accountStatus: 'suspended', authVersion: 1 })
    const { POST } = await import('./route')

    const response = await POST(new NextRequest('https://admin.applymate.site/api/admin/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token: 'a'.repeat(20) }),
    }))

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'Account unavailable' })
    expect(mocks.invitationFindUnique).not.toHaveBeenCalled()
  })

  it('reports when the signed-in account does not match the invitation email', async () => {
    mocks.safeAuth.mockResolvedValue({ user: { id: 'user_1', email: 'admin@example.com', authVersion: 1 } })
    mocks.userFindUnique.mockResolvedValue({ email: 'admin@example.com', accountStatus: 'active', authVersion: 1 })
    mocks.invitationFindUnique.mockResolvedValue({ id: 'invite_1', email: 'invited@example.com', roleId: 'role_1', status: 'pending', expiresAt: new Date(Date.now() + 60_000) })
    const { POST } = await import('./route')

    const response = await POST(new NextRequest('https://admin.applymate.site/api/admin/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token: 'a'.repeat(20) }),
    }))

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'The signed-in account does not match the invited email', code: 'INVITATION_EMAIL_MISMATCH' })
    expect(mocks.membershipFindUnique).not.toHaveBeenCalled()
  })
})
