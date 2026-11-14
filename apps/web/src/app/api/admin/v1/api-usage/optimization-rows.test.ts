import { Prisma } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ queryRaw: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { $queryRaw: mocks.queryRaw } }))

import { loadOptimizationRows } from './optimization-rows'

function capturedSql(call: readonly unknown[]) {
  const [template, ...values] = call
  if (!Array.isArray(template) || !('raw' in template)) throw new Error('Expected a Prisma tagged query')
  const query = Prisma.sql(template as TemplateStringsArray, ...(values as never[]))
  return { text: query.text, values: query.values }
}

describe('loadOptimizationRows', () => {
  beforeEach(() => vi.clearAllMocks())

  it('keeps the date filter and binds an optional provider filter', async () => {
    const since = new Date('2026-11-06T12:00:00.000Z')
    const rows = [{ eventType: 'cache_hit', provider: 'lever', events: 2, requestsAvoided: 2, jobsReturned: 4, netNewJobs: 1, validApplyUrls: 4, completeDescriptions: 3 }]
    mocks.queryRaw.mockResolvedValueOnce(rows)

    await expect(loadOptimizationRows(since, 'lever')).resolves.toEqual(rows)

    const query = capturedSql(mocks.queryRaw.mock.calls[0]!)
    expect(query.text).toContain('FROM discovery_optimization_events')
    expect(query.text).toMatch(/created_at >= \$\d+/)
    expect(query.text).toMatch(/AND provider = \$\d+/)
    expect(query.text).toContain('GROUP BY event_type, provider')
    expect(query.values).toEqual([since, 'lever'])
  })

  it('omits the provider predicate when no provider is selected', async () => {
    const since = new Date('2026-11-06T12:00:00.000Z')
    mocks.queryRaw.mockResolvedValueOnce([])

    await expect(loadOptimizationRows(since, undefined)).resolves.toEqual([])

    const query = capturedSql(mocks.queryRaw.mock.calls[0]!)
    expect(query.text).toMatch(/created_at >= \$\d+/)
    expect(query.text).not.toContain('AND provider =')
    expect(query.values).toEqual([since])
  })

  it('returns an empty result when the optimization query is unavailable', async () => {
    mocks.queryRaw.mockRejectedValueOnce(new Error('query unavailable'))

    await expect(loadOptimizationRows(new Date('2026-11-06T12:00:00.000Z'), 'lever')).resolves.toEqual([])
  })
})
