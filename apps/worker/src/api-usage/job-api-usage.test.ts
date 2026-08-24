import { describe, expect, it, vi } from 'vitest'
import { recordWorkerJobApiUsage } from './job-api-usage.js'

describe('worker job API usage', () => {
  it('records public ATS request metadata without a URL or payload', async () => {
    const query = vi.fn().mockResolvedValue({})
    await recordWorkerJobApiUsage({ pool: { query } as never, userId: 'user-1', provider: 'greenhouse', latencyMs: 42, status: 'success', httpStatus: 200, jobsReturned: 17 })
    expect(query).toHaveBeenCalledOnce()
    expect(query.mock.calls[0][0]).not.toContain('url')
    expect(query.mock.calls[0][1]).toContain('greenhouse')
    expect(query.mock.calls[0][1][3]).toBe(17)
  })
})
