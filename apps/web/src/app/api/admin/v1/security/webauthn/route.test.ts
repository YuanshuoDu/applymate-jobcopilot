import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdminMembership: vi.fn(), findMany: vi.fn(), validate: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdminMembership: mocks.requireAdminMembership, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.validate }))
vi.mock('@/lib/db', () => ({ db: { adminWebAuthnCredential: { findMany: mocks.findMany } } }))

describe('admin WebAuthn route', () => {
  beforeEach(() => { vi.resetModules(); mocks.requireAdminMembership.mockReset(); mocks.findMany.mockReset(); mocks.validate.mockReset().mockReturnValue(null) })

  it('returns registered credential metadata without exposing public keys', async () => {
    mocks.requireAdminMembership.mockResolvedValue({ userId: 'admin-1', roleKey: 'security_admin', permissions: [], requestId: 'request-1' })
    mocks.findMany.mockResolvedValue([{ id: 'credential-1', deviceName: 'Laptop', deviceType: 'multiDevice', createdAt: new Date('2026-08-09T10:00:00Z'), lastUsedAt: null }])
    const { GET } = await import('./route')
    const result = await GET(new Request('https://admin.example/api/admin/v1/security/webauthn'))
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual(expect.objectContaining({ mfaLevel: 'webauthn', credentials: [{ id: 'credential-1', deviceName: 'Laptop', deviceType: 'multiDevice', createdAt: new Date('2026-08-09T10:00:00.000Z').toISOString(), lastUsedAt: null }] }))
  }, 15_000)

  it('rejects unknown actions before touching the database', async () => {
    mocks.requireAdminMembership.mockResolvedValue({ userId: 'admin-1', roleKey: 'security_admin', permissions: [], requestId: 'request-1' })
    const { POST } = await import('./route')
    const result = await POST(new Request('https://admin.example/api/admin/v1/security/webauthn', { method: 'POST', headers: { Origin: 'https://admin.example', Host: 'admin.example', 'Idempotency-Key': 'request-1' }, body: JSON.stringify({ action: 'unknown' }) }))
    expect(result.status).toBe(400)
    expect(mocks.findMany).not.toHaveBeenCalled()
  })
})
