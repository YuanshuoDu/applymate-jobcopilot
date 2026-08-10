import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  validateWrite: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  runMutation: vi.fn(),
}))

vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.validateWrite }))
vi.mock('@/lib/db', () => ({ db: { dataRetentionPolicy: { findUnique: mocks.findUnique } } }))
vi.mock('@/lib/admin/retention', () => ({ RETENTION_POLICY_KEY: 'completed_deletion_requests', getDeletionRetentionPolicy: mocks.findUnique }))
vi.mock('@/lib/admin/write-transaction', () => ({ runAdminMutation: mocks.runMutation }))

describe('/api/admin/v1/users/deletions/retention', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin_1', roleKey: 'super_admin', requestId: 'request_1' })
    mocks.validateWrite.mockReturnValue(null)
    mocks.findUnique.mockResolvedValue({ key: 'completed_deletion_requests', name: 'Completed deletion queue records', retentionDays: 90, enabled: true, version: 1 })
    mocks.update.mockResolvedValue({ key: 'completed_deletion_requests', retentionDays: 120, enabled: true, version: 2 })
    mocks.runMutation.mockImplementation(async (input: { mutate: (tx: unknown) => Promise<unknown> }) => ({ duplicate: false, value: await input.mutate({ dataRetentionPolicy: { update: mocks.update, create: mocks.create } }) }))
  })

  it('updates the configured deletion retention policy with a reason and version', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/admin', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', Host: 'localhost', 'Idempotency-Key': 'retention-key-1' },
      body: JSON.stringify({ key: 'completed_deletion_requests', retentionDays: 120, enabled: true, version: 1, reason: 'Keep deletion receipts for the compliance review window' }),
    }) as never)

    expect(response.status).toBe(200)
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ where: { key: 'completed_deletion_requests', version: 1 }, data: expect.objectContaining({ retentionDays: 120, version: { increment: 1 } }) }))
  })

  it('rejects a stale retention policy update', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/admin', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', Host: 'localhost', 'Idempotency-Key': 'retention-key-2' },
      body: JSON.stringify({ key: 'completed_deletion_requests', retentionDays: 120, enabled: true, version: 0, reason: 'Reject stale retention policy writes safely' }),
    }) as never)

    expect(response.status).toBe(409)
    expect(mocks.runMutation).not.toHaveBeenCalled()
  })
})
