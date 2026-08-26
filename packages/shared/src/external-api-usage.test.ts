import { describe, expect, it, vi } from 'vitest'
import { recordSharedExternalApiUsage, sharedExternalApiErrorCode } from './external-api-usage'

describe('shared external API usage', () => {
  it('persists only safe metadata through the injected pool', async () => {
    const query = vi.fn().mockResolvedValue({})
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    await recordSharedExternalApiUsage({ provider: 'azure-key-vault', operation: 'wrap_key', status: 'success', latencyMs: 8, inputBytes: 32, outputBytes: 256 }, { pool: { query } })
    process.env.NODE_ENV = previous
    expect(query).toHaveBeenCalledWith(expect.stringContaining('external_api_usage_events'), expect.arrayContaining(['azure-key-vault', 'wrap_key', 'platform', 32, 256, 0, 8, 'success', null, null]))
  })

  it('classifies provider errors without retaining response text', () => {
    expect(sharedExternalApiErrorCode({ statusCode: 429, message: 'provider response body' })).toBe('http_429')
    expect(sharedExternalApiErrorCode(new TypeError('network body'))).toBe('network_error')
    expect(sharedExternalApiErrorCode(new Error('sensitive provider body'))).toBe('provider_error')
  })
})
