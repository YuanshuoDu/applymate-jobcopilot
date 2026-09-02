import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ safeAuth: vi.fn(), userFindUnique: vi.fn(), invitationFindUnique: vi.fn(), membershipFindUnique: vi.fn(), membershipCreate: vi.fn(), invitationUpdateMany: vi.fn(), transaction: vi.fn() }))

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
    mocks.membershipCreate.mockReset()
    mocks.invitationUpdateMany.mockReset()
    mocks.transaction.mockReset()
    mocks.membershipCreate.mockResolvedValue({ id: 'membership-1' })
    mocks.invitationUpdateMany.mockResolvedValue({ count: 1 })
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({ adminMembership: { create: mocks.membershipCreate }, adminInvitation: { updateMany: mocks.invitationUpdateMany } }))
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

  it('rejects a revoked invitation token', async () => {
    mocks.safeAuth.mockResolvedValue({ user: { id: 'user_1', email: 'invited@example.com', authVersion: 1 } })
    mocks.userFindUnique.mockResolvedValue({ email: 'invited@example.com', accountStatus: 'active', authVersion: 1 })
    mocks.invitationFindUnique.mockResolvedValue({ id: 'invite_1', email: 'invited@example.com', roleId: 'role_1', status: 'revoked', expiresAt: new Date(Date.now() + 60_000) })
    const { POST } = await import('./route')

    const response = await POST(new NextRequest('https://admin.applymate.site/api/admin/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token: 'a'.repeat(20) }),
    }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Invitation is invalid or expired', code: 'INVITATION_INVALID' })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('consumes the invitation before creating membership', async () => {
    mocks.safeAuth.mockResolvedValue({ user: { id: 'user_1', email: 'invited@example.com', authVersion: 1 } })
    mocks.userFindUnique.mockResolvedValue({ email: 'invited@example.com', accountStatus: 'active', authVersion: 1 })
    mocks.invitationFindUnique.mockResolvedValue({ id: 'invite_1', email: 'invited@example.com', roleId: 'role_1', status: 'pending', expiresAt: new Date(Date.now() + 60_000) })
    mocks.membershipFindUnique.mockResolvedValue(null)
    const { POST } = await import('./route')

    const response = await POST(new NextRequest('https://admin.applymate.site/api/admin/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token: 'a'.repeat(20) }),
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ accepted: true })
    expect(mocks.invitationUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'invite_1', status: 'pending', expiresAt: expect.any(Object) }), data: expect.objectContaining({ status: 'accepted', acceptedAt: expect.any(Date) }) }))
    expect(mocks.membershipCreate).toHaveBeenCalledWith({ data: { userId: 'user_1', roleId: 'role_1' } })
  })

  it('rejects when revocation wins the acceptance race before creating membership', async () => {
    mocks.safeAuth.mockResolvedValue({ user: { id: 'user_1', email: 'invited@example.com', authVersion: 1 } })
    mocks.userFindUnique.mockResolvedValue({ email: 'invited@example.com', accountStatus: 'active', authVersion: 1 })
    mocks.invitationFindUnique.mockResolvedValue({ id: 'invite_1', email: 'invited@example.com', roleId: 'role_1', status: 'pending', expiresAt: new Date(Date.now() + 60_000) })
    mocks.membershipFindUnique.mockResolvedValue(null)
    mocks.invitationUpdateMany.mockResolvedValue({ count: 0 })
    const { POST } = await import('./route')

    const response = await POST(new NextRequest('https://admin.applymate.site/api/admin/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token: 'a'.repeat(20) }),
    }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Invitation is invalid or expired', code: 'INVITATION_INVALID' })
    expect(mocks.membershipCreate).not.toHaveBeenCalled()
  })
})
