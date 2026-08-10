import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  validateWrite: vi.fn(),
  requestFindUnique: vi.fn(),
  requestUpdateMany: vi.fn(),
  requestFindUniqueOrThrow: vi.fn(),
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  adminMembershipFindUnique: vi.fn(),
  userDelete: vi.fn(),
  runMutation: vi.fn(),
}))

vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.validateWrite }))
vi.mock('@/lib/db', () => ({ db: { adminDataDeletionRequest: { findUnique: mocks.requestFindUnique } } }))
vi.mock('@/lib/admin/write-transaction', () => ({
  runAdminMutation: mocks.runMutation,
  AdminMutationConflict: class AdminMutationConflict extends Error {},
}))

const params = Promise.resolve({ id: 'deletion_1' })

describe('/api/admin/v1/users/deletions/:id', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin_1', roleKey: 'super_admin', requestId: 'request_1' })
    mocks.validateWrite.mockReturnValue(null)
    mocks.requestFindUnique.mockResolvedValue({ id: 'deletion_1', userId: 'user_1', status: 'processing', version: 2 })
    mocks.requestUpdateMany.mockResolvedValue({ count: 1 })
    mocks.requestFindUniqueOrThrow.mockResolvedValue({ id: 'deletion_1', userId: null, status: 'completed', version: 3 })
    mocks.userFindUnique.mockResolvedValue({ id: 'user_1' })
    mocks.adminMembershipFindUnique.mockResolvedValue(null)
    mocks.userDelete.mockResolvedValue({ id: 'user_1' })
    mocks.userUpdate.mockResolvedValue({ id: 'user_1' })
    mocks.runMutation.mockImplementation(async (input: { mutate: (tx: unknown) => Promise<unknown> }) => ({
      duplicate: false,
      value: await input.mutate({
        adminDataDeletionRequest: { updateMany: mocks.requestUpdateMany, findUniqueOrThrow: mocks.requestFindUniqueOrThrow },
        user: { findUnique: mocks.userFindUnique, update: mocks.userUpdate, delete: mocks.userDelete },
        adminMembership: { findUnique: mocks.adminMembershipFindUnique },
      }),
    }))
  })

  it('erases the user inside the audited completion transaction', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/admin', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', Host: 'localhost', 'Idempotency-Key': 'delete-key-1' },
      body: JSON.stringify({ status: 'completed', version: 2, reason: 'Execute the verified GDPR deletion request' }),
    }) as never, { params })

    expect(response.status).toBe(200)
    expect(mocks.requestUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: 'user_1', version: 2 }) }))
    expect(mocks.userDelete).toHaveBeenCalledWith({ where: { id: 'user_1' } })
  })

  it('refuses to delete an administrator account until membership is revoked', async () => {
    mocks.adminMembershipFindUnique.mockResolvedValue({ id: 'membership_1' })
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/admin', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', Host: 'localhost', 'Idempotency-Key': 'delete-key-2' },
      body: JSON.stringify({ status: 'completed', version: 2, reason: 'Do not erase an active administrator account' }),
    }) as never, { params })

    expect(response.status).toBe(409)
    expect(mocks.userDelete).not.toHaveBeenCalled()
  })

  it('cancels without erasing the user account', async () => {
    mocks.requestFindUnique.mockResolvedValue({ id: 'deletion_1', userId: 'user_1', status: 'requested', version: 1 })
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/admin', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', Host: 'localhost', 'Idempotency-Key': 'delete-key-3' },
      body: JSON.stringify({ status: 'cancelled', version: 1, reason: 'The user withdrew the deletion request' }),
    }) as never, { params })

    expect(response.status).toBe(200)
    expect(mocks.userDelete).not.toHaveBeenCalled()
    expect(mocks.userUpdate).toHaveBeenCalled()
  })

  it('denies callers without deletion permission before reading the queue item', async () => {
    mocks.requireAdmin.mockResolvedValue(Response.json({ error: 'Forbidden' }, { status: 403 }))
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/admin', { method: 'PATCH', headers: { Origin: 'http://localhost', Host: 'localhost' }, body: '{}' }) as never, { params })

    expect(response.status).toBe(403)
    expect(mocks.requestFindUnique).not.toHaveBeenCalled()
  })
})
