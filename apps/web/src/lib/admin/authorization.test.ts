import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ safeAuth: vi.fn(), findUnique: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/safe-auth', () => ({ safeAuth: mocks.safeAuth }))
vi.mock('@/lib/db', () => ({ db: { adminMembership: { findUnique: mocks.findUnique } } }))
vi.mock('./audit', () => ({ requestIdFor: () => 'request-1', writeAdminAudit: mocks.audit }))

describe('requireAdmin', () => {
  beforeEach(() => { vi.resetModules(); mocks.safeAuth.mockReset(); mocks.findUnique.mockReset(); mocks.audit.mockReset() })
  it('denies an old admin session after the membership session version changes', async () => {
    mocks.safeAuth.mockResolvedValue({ user: { id: 'admin-1', plan: 'pro', adminSessionVersion: 1 } })
    mocks.findUnique.mockResolvedValue({ status: 'active', mfaLevel: 'totp', sessionVersion: 2, role: { key: 'operations', permissions: ['observability.read'] } })
    const { requireAdmin } = await import('./authorization')
    const result = await requireAdmin('observability.read', new Request('http://localhost/api/admin/v1/observability'))
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(403)
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'permission_denied', outcome: 'denied' }))
  })

  it('allows a permission only when the active membership and session version match', async () => {
    mocks.safeAuth.mockResolvedValue({ user: { id: 'admin-1', plan: 'pro', adminSessionVersion: 2 } })
    mocks.findUnique.mockResolvedValue({ status: 'active', mfaLevel: 'totp', sessionVersion: 2, role: { key: 'operations', permissions: ['observability.read'] } })
    const { requireAdmin, isAdminResponse } = await import('./authorization')
    const result = await requireAdmin('observability.read')
    expect(isAdminResponse(result)).toBe(false)
    if (!isAdminResponse(result)) expect(result.roleKey).toBe('operations')
  })
})
