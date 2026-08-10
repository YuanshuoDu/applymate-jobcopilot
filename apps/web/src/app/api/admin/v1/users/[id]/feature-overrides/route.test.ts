import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  validateWrite: vi.fn(),
  findMany: vi.fn(),
  userFindUnique: vi.fn(),
  upsert: vi.fn(),
  deleteMany: vi.fn(),
  runMutation: vi.fn(),
}))

vi.mock('@/lib/admin/authorization', () => ({
  requireAdmin: mocks.requireAdmin,
  isAdminResponse: (value: unknown) => value instanceof Response,
}))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.validateWrite }))
vi.mock('@/lib/admin/user-lifecycle', () => ({
  parseFeatureOverride: (value: unknown) => {
    const input = value as Record<string, unknown>
    return typeof input.featureKey === 'string' && typeof input.enabled === 'boolean'
      ? { featureKey: input.featureKey, enabled: input.enabled, limit: input.limit ?? null, expiresAt: null }
      : { error: 'Invalid feature override' }
  },
  reasonFrom: (value: unknown) => typeof value === 'string' && value.trim().length >= 10 ? value.trim() : { error: 'reason is required' },
}))
vi.mock('@/lib/db', () => ({ db: { userFeatureOverride: { findMany: mocks.findMany }, user: { findUnique: mocks.userFindUnique } } }))
vi.mock('@/lib/admin/write-transaction', () => ({ runAdminMutation: mocks.runMutation }))

const params = Promise.resolve({ id: 'user_1' })

describe('/api/admin/v1/users/:id/feature-overrides', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin_1', roleKey: 'super_admin', requestId: 'request_1' })
    mocks.validateWrite.mockReturnValue(null)
    mocks.userFindUnique.mockResolvedValue({ id: 'user_1' })
    mocks.upsert.mockResolvedValue({ id: 'override_1', featureKey: 'auto_apply', enabled: true, limit: null, expiresAt: null })
    mocks.deleteMany.mockResolvedValue({ count: 1 })
    mocks.runMutation.mockImplementation(async (input: { mutate: (tx: unknown) => Promise<unknown> }) => ({
      duplicate: false,
      value: await input.mutate({ userFeatureOverride: { upsert: mocks.upsert, deleteMany: mocks.deleteMany } }),
    }))
  })

  it('lets a core administrator grant a user feature permission with audit-backed mutation', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/admin', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', Host: 'localhost', 'Idempotency-Key': 'override-key-1' },
      body: JSON.stringify({ featureKey: 'auto_apply', enabled: true, reason: 'Granting temporary auto apply access' }),
    }) as never, { params })

    expect(response.status).toBe(200)
    expect(mocks.requireAdmin).toHaveBeenCalledWith('users.feature_override', expect.any(Request))
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { userId_featureKey: { userId: 'user_1', featureKey: 'auto_apply' } } }))
  })

  it('lets a core administrator remove an override so the user inherits package permissions', async () => {
    const { DELETE } = await import('./route')
    const response = await DELETE(new NextRequest('http://localhost/admin/users/user_1/feature-overrides?featureKey=auto_apply&reason=Removing%20temporary%20access', { method: 'DELETE', headers: { Origin: 'http://localhost', Host: 'localhost', 'Idempotency-Key': 'override-key-2' } }), { params })

    expect(response.status).toBe(200)
    expect(mocks.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user_1', featureKey: 'auto_apply' } })
  })
})
