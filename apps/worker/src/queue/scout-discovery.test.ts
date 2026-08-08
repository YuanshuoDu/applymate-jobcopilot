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
    const request = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: [] }), { status: 200 }))

    await expect(discoverGreenhouseJobs({
      pool: policyPool('enabled', true, 1),
      redis: { set: vi.fn().mockResolvedValue('OK'), pttl: vi.fn() },
      request,
      sleep: vi.fn(),
      userId: 'user-1',
      slugs: ['n26'],
    })).resolves.toEqual([])

    expect(request).toHaveBeenCalledTimes(2)
  })
})
