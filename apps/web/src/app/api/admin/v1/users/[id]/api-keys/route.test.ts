import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), validateWrite: vi.fn(), findUnique: vi.fn(), deleteMany: vi.fn(), runMutation: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.validateWrite }))
vi.mock('@/lib/db', () => ({ db: { userApiKeys: { findUnique: mocks.findUnique } } }))
vi.mock('@/lib/admin/write-transaction', () => ({ runAdminMutation: mocks.runMutation }))

describe('/api/admin/v1/users/:id/api-keys', () => {
  beforeEach(() => {
    vi.resetModules(); Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1', roleKey: 'security_admin', requestId: 'req-1' })
    mocks.validateWrite.mockReturnValue(null)
    mocks.findUnique.mockResolvedValue({ id: 'keys-1', adzunaAppId: 'id', adzunaAppKey: 'secret', rapidapiKey: null, createdAt: new Date(), updatedAt: new Date() })
    mocks.deleteMany.mockResolvedValue({ count: 1 })
    mocks.runMutation.mockImplementation(async (input: { mutate: (tx: unknown) => Promise<unknown> }) => ({ duplicate: false, value: await input.mutate({ userApiKeys: { deleteMany: mocks.deleteMany } }) }))
  })

  it('returns provider readiness without returning secret values', async () => {
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/admin/users/user-1/api-keys') as never, { params: Promise.resolve({ id: 'user-1' }) })
    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload).toMatchObject({ keys: { providers: { adzuna: true, rapidapi: false } } })
    expect(JSON.stringify(payload)).not.toContain('secret')
  })

  it('revokes all stored keys through the audited mutation', async () => {
    const { DELETE } = await import('./route')
    const response = await DELETE(new Request('http://localhost/admin/users/user-1/api-keys', { method: 'DELETE', headers: { Origin: 'http://localhost', Host: 'localhost', 'Idempotency-Key': 'key-1', 'x-admin-reason': 'Revoking exposed discovery credentials' } }) as never, { params: Promise.resolve({ id: 'user-1' }) })
    expect(response.status).toBe(200)
    expect(mocks.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } })
  })
})
