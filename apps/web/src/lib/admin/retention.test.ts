import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), deleteMany: vi.fn() }))

vi.mock('@/lib/db', () => ({ db: { dataRetentionPolicy: { findUnique: mocks.findUnique }, adminDataDeletionRequest: { deleteMany: mocks.deleteMany } } }))

describe('deletion retention cleanup', () => {
  beforeEach(() => {
    mocks.findUnique.mockReset()
    mocks.deleteMany.mockReset()
    mocks.findUnique.mockResolvedValue({ key: 'completed_deletion_requests', retentionDays: 90, enabled: true })
    mocks.deleteMany.mockResolvedValue({ count: 2 })
  })

  it('purges old completed and cancelled queue receipts without retaining user links', async () => {
    const { purgeRetainedDeletionRecords } = await import('./retention')
    await expect(purgeRetainedDeletionRecords(new Date('2026-08-10T00:00:00Z'))).resolves.toMatchObject({ deleted: 2, skipped: false })
    expect(mocks.deleteMany).toHaveBeenCalledWith({ where: { status: { in: ['completed', 'cancelled'] }, updatedAt: { lt: new Date('2026-05-12T00:00:00.000Z') } } })
  })

  it('does not purge when the policy is disabled', async () => {
    mocks.findUnique.mockResolvedValue({ key: 'completed_deletion_requests', retentionDays: 90, enabled: false })
    const { purgeRetainedDeletionRecords } = await import('./retention')
    await expect(purgeRetainedDeletionRecords()).resolves.toMatchObject({ deleted: 0, skipped: true })
    expect(mocks.deleteMany).not.toHaveBeenCalled()
  })
})
