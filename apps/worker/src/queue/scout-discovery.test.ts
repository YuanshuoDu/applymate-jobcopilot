import type { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { discoverGreenhouseJobs } from './scout-discovery.js'

function policyPool(state = 'enabled', enabled = true, maxRetries = 0) {
  return {
    query: vi.fn().mockResolvedValue({
      rows: [{
        state,
        enabled,
        rollout_percent: 100,
        global_rps_limit: 5,
        per_tenant_rps_limit: 1,
        max_retries: maxRetries,
        backoff_base_ms: 100,
        allow_auto_apply: true,
        version: 1,
      }],
    }),
  } as unknown as Pool
}

describe('policy-aware Scout discovery', () => {
  it('does not make an outbound request when the source is paused', async () => {
    const request = vi.fn()

    await expect(discoverGreenhouseJobs({
      pool: policyPool('paused', false),
      redis: { set: vi.fn(), pttl: vi.fn() },
      request,
      sleep: vi.fn(),
      userId: 'user-1',
      slugs: ['n26'],
    })).resolves.toEqual([])

    expect(request).not.toHaveBeenCalled()
  })

  it('retries a retryable provider response before skipping the source', async () => {
    const pool = policyPool('enabled', true, 1)
    const request = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: [
        { id: 1, title: 'Engineer', absolute_url: 'https://example.com/1', location: { name: 'Berlin' } },
        { id: 2, title: 'Designer', absolute_url: 'https://example.com/2', location: { name: 'Dublin' } },
      ] }), { status: 200 }))

    const jobs = await discoverGreenhouseJobs({
      pool,
      redis: { set: vi.fn().mockResolvedValue('OK'), pttl: vi.fn() },
      request,
      sleep: vi.fn(),
      userId: 'user-1',
      slugs: ['n26'],
    })

    expect(request).toHaveBeenCalledTimes(2)
    expect(jobs).toHaveLength(2)
    const usageWrites = vi.mocked(pool.query).mock.calls.filter(call => String(call[0]).includes('INSERT INTO job_api_usage_events'))
    expect(usageWrites).toHaveLength(2)
    expect(usageWrites[0][1]?.[3]).toBe(0)
    expect(usageWrites[1][1]?.[3]).toBe(2)
  })
})
