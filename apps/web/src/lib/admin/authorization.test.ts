import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ safeAuth: vi.fn(), findUnique: vi.fn(), findGrant: vi.fn(), findReauth: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/safe-auth', () => ({ safeAuth: mocks.safeAuth }))
vi.mock('@/lib/db', () => ({ db: { adminMembership: { findUnique: mocks.findUnique }, adminBreakGlassGrant: { findFirst: mocks.findGrant }, adminReauthGrant: { findFirst: mocks.findReauth } } }))
vi.mock('./audit', () => ({ requestIdFor: () => 'request-1', writeAdminAudit: mocks.audit }))

describe('requireAdmin', () => {
  beforeEach(() => { vi.resetModules(); mocks.safeAuth.mockReset(); mocks.findUnique.mockReset(); mocks.findGrant.mockReset(); mocks.findReauth.mockReset(); mocks.audit.mockReset() })
  it('rejects an invalid cross-origin write before authentication or auditing', async () => {
    const { requireAdmin } = await import('./authorization')

    const result = await requireAdmin('queues.pause', new Request('http://localhost/api/admin/v1/queues/apply-tasks/pause', {
      method: 'POST',
      headers: { Origin: 'https://untrusted.example', Host: 'localhost', 'Idempotency-Key': 'cross-origin-1' },
    }))

    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(403)
    expect(mocks.safeAuth).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it('rejects an admin API request sent to the public application host', async () => {
    const { requireAdmin } = await import('./authorization')
    const result = await requireAdmin('queues.pause', new Request('https://applymate.site/api/admin/v1/queues/apply-tasks/pause', {
      method: 'POST',
      headers: { Origin: 'https://applymate.site', Host: 'applymate.site', 'Idempotency-Key': 'public-host-1' },
    }))

    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(404)
    expect(mocks.safeAuth).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it('denies an old admin session after the membership session version changes', async () => {
    mocks.safeAuth.mockResolvedValue({ user: { id: 'admin-1', plan: 'pro', adminSessionVersion: 1, authVersion: 1 } })
    mocks.findUnique.mockResolvedValue({ status: 'active', mfaLevel: 'totp', sessionVersion: 2, user: { accountStatus: 'active', authVersion: 1 }, role: { key: 'operations', permissions: ['observability.read'] } })
    const { requireAdmin } = await import('./authorization')
    const result = await requireAdmin('observability.read', new Request('http://localhost/api/admin/v1/observability'))
    expect(result).toBeInstanceOf(Response)
    expect((result as unknown as Response).status).toBe(403)
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'permission_denied', outcome: 'denied' }))
  })

  it('allows a permission only when the active membership and session version match', async () => {
    mocks.safeAuth.mockResolvedValue({ user: { id: 'admin-1', plan: 'pro', adminSessionVersion: 2, authVersion: 1 } })
    mocks.findUnique.mockResolvedValue({ status: 'active', mfaLevel: 'totp', sessionVersion: 2, user: { accountStatus: 'active', authVersion: 1 }, role: { key: 'operations', permissions: ['observability.read'] } })
    const { requireAdmin, isAdminResponse } = await import('./authorization')
    const result = await requireAdmin('observability.read')
    expect(isAdminResponse(result)).toBe(false)
    if (!isAdminResponse(result)) expect(result.roleKey).toBe('operations')
  })

  it('allows a super admin without MFA to bootstrap the first WebAuthn key', async () => {
    mocks.safeAuth.mockResolvedValue({ user: { id: 'admin-1', adminSessionVersion: 2, authVersion: 1 } })
    mocks.findUnique.mockResolvedValue({ status: 'active', mfaLevel: 'none', sessionVersion: 2, user: { accountStatus: 'active', authVersion: 1 }, role: { key: 'super_admin', permissions: ['security.webauthn.manage'] } })
    const { requireAdminMembership, isAdminResponse } = await import('./authorization')
    const result = await requireAdminMembership(new Request('https://admin.applymate.site/api/admin/v1/security/webauthn', { method: 'POST' }))
    expect(isAdminResponse(result)).toBe(false)
  })

  it('does not treat the WebAuthn bootstrap exception as fresh reauthentication', async () => {
    mocks.safeAuth.mockResolvedValue({ user: { id: 'admin-1', adminSessionVersion: 2, authVersion: 1 } })
    mocks.findUnique.mockResolvedValue({ status: 'active', mfaLevel: 'none', sessionVersion: 2, user: { accountStatus: 'active', authVersion: 1 }, role: { key: 'super_admin', permissions: ['billing.update'] } })
    const { requireAdmin } = await import('./authorization')
    const result = await requireAdmin('billing.update', new Request('https://admin.applymate.site/api/admin/v1/users/u1/subscription', { method: 'POST', headers: { Origin: 'https://admin.applymate.site', Host: 'admin.applymate.site', 'Idempotency-Key': 'bootstrap-security-check' } }))
    expect(result).toBeInstanceOf(Response)
    expect(await (result as Response).json()).toEqual(expect.objectContaining({ code: 'reauth_required' }))
  })

  it('permits an approved unexpired break-glass grant without changing the membership role', async () => {
    mocks.safeAuth.mockResolvedValue({ user: { id: 'admin-1', plan: 'pro', adminSessionVersion: 2, authVersion: 1 } })
    mocks.findUnique.mockResolvedValue({ status: 'active', mfaLevel: 'totp', sessionVersion: 2, user: { accountStatus: 'active', authVersion: 1 }, role: { key: 'operations', permissions: [] } })
    mocks.findGrant.mockResolvedValue({ id: 'grant-1' })
    const { requireAdmin, isAdminResponse } = await import('./authorization')
    const result = await requireAdmin('queues.pause')
    expect(isAdminResponse(result)).toBe(false)
    if (!isAdminResponse(result)) expect(result.permissions).toContain('queues.pause')
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'break_glass.used' }))
  })

  it('requires fresh WebAuthn for a high-risk request', async () => {
    mocks.safeAuth.mockResolvedValue({ user: { id: 'admin-1', plan: 'pro', adminSessionVersion: 2, authVersion: 1 } })
    mocks.findUnique.mockResolvedValue({ status: 'active', mfaLevel: 'webauthn', sessionVersion: 2, user: { accountStatus: 'active', authVersion: 1 }, role: { key: 'operations', permissions: ['queues.pause'] } })
    mocks.findReauth.mockResolvedValue(null)
    const { requireAdmin } = await import('./authorization')
    const result = await requireAdmin('queues.pause', new Request('http://localhost/api/admin/v1/queues/apply-tasks/pause', { headers: { Cookie: 'applymate-admin-reauth=expired' } }))
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(403)
    expect(await (result as Response).json()).toEqual(expect.objectContaining({ code: 'reauth_required' }))
  })

  it('requires fresh WebAuthn before changing a user feature permission', async () => {
    mocks.safeAuth.mockResolvedValue({ user: { id: 'admin-1', plan: 'pro', adminSessionVersion: 2, authVersion: 1 } })
    mocks.findUnique.mockResolvedValue({ status: 'active', mfaLevel: 'webauthn', sessionVersion: 2, user: { accountStatus: 'active', authVersion: 1 }, role: { key: 'platform_admin', permissions: ['users.feature_override'] } })
    mocks.findReauth.mockResolvedValue(null)
    const { requireAdmin } = await import('./authorization')
    const result = await requireAdmin('users.feature_override', new Request('http://localhost/api/admin/v1/users/u1/feature-overrides', { method: 'PATCH', headers: { Origin: 'http://localhost', Host: 'localhost', 'Idempotency-Key': 'override-reauth-1' } }))
    expect(result).toBeInstanceOf(Response)
    expect(await (result as Response).json()).toEqual(expect.objectContaining({ code: 'reauth_required' }))
  })

  it('denies an admin session after the user auth version changes', async () => {
    mocks.safeAuth.mockResolvedValue({ user: { id: 'admin-1', plan: 'pro', adminSessionVersion: 2, authVersion: 1 } })
    mocks.findUnique.mockResolvedValue({ status: 'active', mfaLevel: 'totp', sessionVersion: 2, user: { accountStatus: 'active', authVersion: 2 }, role: { key: 'operations', permissions: ['observability.read'] } })
    const { requireAdmin } = await import('./authorization')

    const result = await requireAdmin('observability.read')

    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(403)
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'permission_denied', outcome: 'denied' }))
  })
})
