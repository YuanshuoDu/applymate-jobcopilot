import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  safeAuth: vi.fn(),
  findUnique: vi.fn(),
  auditCreate: vi.fn().mockResolvedValue({ id: 'audit_1' }),
}))

vi.mock('@/lib/safe-auth', () => ({ safeAuth: mocks.safeAuth }))
vi.mock('@/lib/db', () => ({
  db: {
    adminMembership: { findUnique: mocks.findUnique },
    adminAuditLog: { create: mocks.auditCreate },
  },
}))

import { AdminAuthorizationError, requireAdmin } from './authorization'

describe('requireAdmin', () => {
  beforeEach(() => {
    mocks.safeAuth.mockReset()
    mocks.findUnique.mockReset()
    mocks.auditCreate.mockClear()
  })

  it('rejects an unauthenticated request', async () => {
    mocks.safeAuth.mockResolvedValue(null)
    await expect(requireAdmin('users.read')).rejects.toMatchObject({ status: 401, code: 'ADMIN_UNAUTHENTICATED' } satisfies Partial<AdminAuthorizationError>)
  })

  it('rejects a user without an internal membership', async () => {
    mocks.safeAuth.mockResolvedValue({ user: { id: 'user_1', plan: 'pro' } })
    mocks.findUnique.mockResolvedValue(null)
    await expect(requireAdmin('users.read')).rejects.toMatchObject({ status: 403, code: 'ADMIN_MEMBERSHIP_REQUIRED' })
  })

  it('rejects suspended memberships and stale session versions', async () => {
    mocks.safeAuth.mockResolvedValue({ user: { id: 'admin_1', adminSessionVersion: 2 } })
    mocks.findUnique.mockResolvedValue({ status: 'suspended', sessionVersion: 2, role: { key: 'support', permissions: ['users.read'] } })
    await expect(requireAdmin('users.read')).rejects.toMatchObject({ status: 403, code: 'ADMIN_MEMBERSHIP_INACTIVE' })

    mocks.findUnique.mockResolvedValue({ status: 'active', sessionVersion: 3, role: { key: 'support', permissions: ['users.read'] } })
    await expect(requireAdmin('users.read')).rejects.toMatchObject({ status: 403, code: 'ADMIN_SESSION_REVOKED' })
  })

  it('rejects a role that does not hold the requested permission', async () => {
    mocks.safeAuth.mockResolvedValue({ user: { id: 'admin_1', adminSessionVersion: 2 } })
    mocks.findUnique.mockResolvedValue({ status: 'active', sessionVersion: 2, role: { key: 'support', permissions: ['support_cases.read'] } })
    await expect(requireAdmin('billing.update')).rejects.toMatchObject({ status: 403, code: 'ADMIN_PERMISSION_DENIED' })
  })

  it('returns an immutable safe actor for an allowed request', async () => {
    mocks.safeAuth.mockResolvedValue({ user: { id: 'admin_1', email: 'admin@example.com', adminSessionVersion: 2 } })
    mocks.findUnique.mockResolvedValue({ id: 'membership_1', status: 'active', mfaLevel: 'totp', sessionVersion: 2, role: { key: 'support', permissions: ['users.read'] } })
    const actor = await requireAdmin('users.read')
    expect(actor).toEqual({
      userId: 'admin_1',
      email: 'admin@example.com',
      membershipId: 'membership_1',
      roleKey: 'support',
      permissions: ['users.read'],
      mfaLevel: 'totp',
      sessionVersion: 2,
    })
    expect(Object.isFrozen(actor)).toBe(true)
  })
})
