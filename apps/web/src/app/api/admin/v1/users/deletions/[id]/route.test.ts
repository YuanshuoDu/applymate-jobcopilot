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
  sourceFence: vi.fn(),
  events: [] as string[],
  AdminMutationConflict: class AdminMutationConflict extends Error {},
}))

vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.validateWrite }))
vi.mock('@/lib/db', () => ({ db: { adminDataDeletionRequest: { findUnique: mocks.requestFindUnique } } }))
vi.mock('@/lib/admin/write-transaction', () => ({
  runAdminMutation: mocks.runMutation,
  AdminMutationConflict: mocks.AdminMutationConflict,
}))
vi.mock('@/lib/agent/source-material-fence', () => ({ acquireSourceMaterialFence: mocks.sourceFence }))

const params = Promise.resolve({ id: 'deletion_1' })

describe('/api/admin/v1/users/deletions/:id', () => {
  beforeEach(() => {
    vi.resetModules()
    ;[mocks.requireAdmin, mocks.validateWrite, mocks.requestFindUnique, mocks.requestUpdateMany,
      mocks.requestFindUniqueOrThrow, mocks.userFindUnique, mocks.userUpdate, mocks.adminMembershipFindUnique,
      mocks.userDelete, mocks.runMutation, mocks.sourceFence].forEach(mock => mock.mockReset())
    mocks.events.length = 0
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin_1', roleKey: 'super_admin', requestId: 'request_1' })
    mocks.validateWrite.mockReturnValue(null)
    mocks.requestFindUnique.mockResolvedValue({ id: 'deletion_1', userId: 'user_1', status: 'processing', version: 2 })
    mocks.requestUpdateMany.mockResolvedValue({ count: 1 })
    mocks.requestFindUniqueOrThrow.mockResolvedValue({ id: 'deletion_1', userId: null, status: 'completed', version: 3 })
    mocks.userFindUnique.mockResolvedValue({ id: 'user_1' })
    mocks.adminMembershipFindUnique.mockResolvedValue(null)
    mocks.userDelete.mockResolvedValue({ id: 'user_1' })
    mocks.userUpdate.mockResolvedValue({ id: 'user_1' })
    mocks.sourceFence.mockImplementation(async (_tx: unknown, userIds: readonly string[]) => {
      mocks.events.push(`source-fence:${userIds.join(',')}`)
    })
    mocks.requestUpdateMany.mockImplementation(async () => {
      mocks.events.push('request-update')
      return { count: 1 }
    })
    mocks.runMutation.mockImplementation(async (input: { beforeIdempotencyClaim?: (tx: unknown) => Promise<void>; mutate: (tx: unknown) => Promise<unknown> }) => {
      const tx = {
        adminDataDeletionRequest: { updateMany: mocks.requestUpdateMany, findUniqueOrThrow: mocks.requestFindUniqueOrThrow },
        user: { findUnique: mocks.userFindUnique, update: mocks.userUpdate, delete: mocks.userDelete },
        adminMembership: { findUnique: mocks.adminMembershipFindUnique },
      }
      await input.beforeIdempotencyClaim?.(tx)
      return { duplicate: false, value: await input.mutate(tx) }
    })
  })

  it('erases the user inside the audited completion transaction', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/admin', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', Host: 'localhost', 'Idempotency-Key': 'delete-key-1' },
      body: JSON.stringify({ status: 'completed', version: 2, reason: 'Execute the verified GDPR deletion request', userId: 'attacker' }),
    }) as never, { params })

    expect(response.status).toBe(200)
    expect(mocks.sourceFence).toHaveBeenCalledOnce()
    expect(mocks.sourceFence).toHaveBeenCalledWith(expect.anything(), ['user_1'])
    expect(mocks.events).toEqual(['source-fence:user_1', 'request-update'])
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
    expect(mocks.sourceFence).not.toHaveBeenCalled()
  })

  it('does not fence non-destructive processing transitions', async () => {
    mocks.requestFindUnique.mockResolvedValue({ id: 'deletion_1', userId: 'user_1', status: 'requested', version: 1 })
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/admin', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', Host: 'localhost', 'Idempotency-Key': 'delete-key-4' },
      body: JSON.stringify({ status: 'processing', version: 1, reason: 'Review the verified deletion request' }),
    }) as never, { params })

    expect(response.status).toBe(200)
    expect(mocks.sourceFence).not.toHaveBeenCalled()
  })

  it('preserves idempotent replay without deleting a second time', async () => {
    mocks.runMutation.mockResolvedValueOnce({ duplicate: true })
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/admin', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', Host: 'localhost', 'Idempotency-Key': 'delete-key-replay' },
      body: JSON.stringify({ status: 'completed', version: 2, reason: 'Replay the verified GDPR deletion request' }),
    }) as never, { params })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ duplicate: true })
    expect(mocks.userDelete).not.toHaveBeenCalled()
  })

  it('returns a conflict when the in-transaction deletion-request CAS is stale', async () => {
    mocks.requestUpdateMany.mockResolvedValueOnce({ count: 0 })
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/admin', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', Host: 'localhost', 'Idempotency-Key': 'delete-key-stale' },
      body: JSON.stringify({ status: 'completed', version: 2, reason: 'Reject a stale deletion request version' }),
    }) as never, { params })

    expect(response.status).toBe(409)
    expect(mocks.userDelete).not.toHaveBeenCalled()
  })

  it('denies callers without deletion permission before reading the queue item', async () => {
    mocks.requireAdmin.mockResolvedValue(Response.json({ error: 'Forbidden' }, { status: 403 }))
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/admin', { method: 'PATCH', headers: { Origin: 'http://localhost', Host: 'localhost' }, body: '{}' }) as never, { params })

    expect(response.status).toBe(403)
    expect(mocks.requestFindUnique).not.toHaveBeenCalled()
  })
})
