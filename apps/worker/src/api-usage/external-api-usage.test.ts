import { describe, expect, it, vi } from 'vitest'
import { recordWorkerExternalApiUsage } from './external-api-usage.js'

describe('worker external API usage', () => {
  it('records safe metadata and no body fields', async () => {
    const query = vi.fn().mockResolvedValue({})
    await recordWorkerExternalApiUsage({ pool: { query }, userId: 'u1', provider: 'resend', operation: 'apply_result', status: 'success', latencyMs: 12, inputBytes: 20 })
    expect(query).toHaveBeenCalledWith(expect.stringContaining('external_api_usage_events'), expect.arrayContaining(['u1', 'resend', 'apply_result', 20, 0]))
    expect(query.mock.calls[0][1]).not.toContain('email body')
  })
})
