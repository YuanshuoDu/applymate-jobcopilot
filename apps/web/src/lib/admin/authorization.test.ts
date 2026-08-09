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

  it('permits an approved unexpired break-glass grant without changing the membership role', async () => {
    mocks.safeAuth.mockResolvedValue({ user: { id: 'admin-1', plan: 'pro', adminSessionVersion: 2 } })
    mocks.findUnique.mockResolvedValue({ status: 'active', mfaLevel: 'totp', sessionVersion: 2, role: { key: 'operations', permissions: [] } })
    mocks.findGrant.mockResolvedValue({ id: 'grant-1' })
    const { requireAdmin, isAdminResponse } = await import('./authorization')
    const result = await requireAdmin('queues.pause')
    expect(isAdminResponse(result)).toBe(false)
    if (!isAdminResponse(result)) expect(result.permissions).toContain('queues.pause')
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'break_glass.used' }))
  })

  it('requires fresh WebAuthn for a high-risk request', async () => {
    mocks.safeAuth.mockResolvedValue({ user: { id: 'admin-1', plan: 'pro', adminSessionVersion: 2 } })
    mocks.findUnique.mockResolvedValue({ status: 'active', mfaLevel: 'webauthn', sessionVersion: 2, role: { key: 'operations', permissions: ['queues.pause'] } })
    mocks.findReauth.mockResolvedValue(null)
    const { requireAdmin } = await import('./authorization')
    const result = await requireAdmin('queues.pause', new Request('http://localhost/api/admin/v1/queues/apply-tasks/pause', { headers: { Cookie: 'applymate-admin-reauth=expired' } }))
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(403)
    expect(await (result as Response).json()).toEqual(expect.objectContaining({ code: 'reauth_required' }))
  })
})
