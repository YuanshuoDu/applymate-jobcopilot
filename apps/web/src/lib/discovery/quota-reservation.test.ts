import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  db: {
    $transaction: vi.fn(),
    apiQuota: { findMany: vi.fn() },
    jobApiUsageEvent: { aggregate: vi.fn() },
    apiQuotaReservation: { aggregate: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  },
}))

vi.mock('@/lib/db', () => ({ db: mocks.db }))

import { reserveProviderQuota } from './quota'

type MockDb = typeof mocks.db

describe('provider quota reservations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NODE_ENV', 'production')
    mocks.db.$transaction.mockImplementation(async (callback: (tx: MockDb) => Promise<unknown>) => callback(mocks.db))
  })

  it('does not leave a partial reservation when one quota metric is exhausted', async () => {
    mocks.db.apiQuota.findMany.mockResolvedValue([
      { id: 'fj-requests', provider: 'fantasticjobs', operation: '*', metric: 'requests', period: 'week', resetDay: 1, limit: 50, enabled: true },
      { id: 'fj-jobs', provider: 'fantasticjobs', operation: '*', metric: 'jobs', period: 'week', resetDay: 1, limit: 500, enabled: true },
    ])
    mocks.db.jobApiUsageEvent.aggregate
      .mockResolvedValueOnce({ _sum: { requestCount: 0, jobsReturned: 0 } })
      .mockResolvedValueOnce({ _sum: { requestCount: 0, jobsReturned: 500 } })
    mocks.db.apiQuotaReservation.aggregate.mockResolvedValue({ _sum: { requestedUnits: 0 } })

    await expect(reserveProviderQuota({
      provider: 'fantasticjobs', operation: 'list', credentialSource: 'platform', expectedJobs: 20,
    })).resolves.toBeNull()
    expect(mocks.db.apiQuotaReservation.create).not.toHaveBeenCalled()
  })
})
