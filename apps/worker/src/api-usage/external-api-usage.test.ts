import { describe, expect, it, vi } from 'vitest'
import { measureWorkerResponseBytes, recordWorkerExternalApiUsage } from './external-api-usage.js'

describe('worker external API usage', () => {
  it('records safe metadata and no body fields', async () => {
    const query = vi.fn().mockResolvedValue({})
    await recordWorkerExternalApiUsage({ pool: { query }, userId: 'u1', provider: 'resend', operation: 'apply_result', status: 'success', latencyMs: 12, inputBytes: 20 })
    expect(query).toHaveBeenCalledWith(expect.stringContaining('external_api_usage_events'), expect.arrayContaining(['u1', 'resend', 'apply_result', 20, 0]))
    expect(query.mock.calls[0][1]).not.toContain('email body')
  })
  it('normalizes raw provider errors and ignores error codes on success', async () => {
    const query = vi.fn().mockResolvedValue({})
    await recordWorkerExternalApiUsage({ pool: { query }, provider: 'resend', operation: 'apply_result', status: 'error', latencyMs: 1, httpStatus: 429, errorCode: 'provider response body' })
    await recordWorkerExternalApiUsage({ pool: { query }, provider: 'resend', operation: 'apply_result', status: 'success', latencyMs: 1, errorCode: 'provider response body' })
    expect(query.mock.calls[0][1].at(-2)).toBe(429)
    expect(query.mock.calls[0][1].at(-1)).toBe('http_429')
    expect(query.mock.calls[1][1].at(-1)).toBeNull()
    expect(JSON.stringify(query.mock.calls)).not.toContain('provider response body')
  })
  it('measures response bytes without exposing response content', async () => {
    await expect(measureWorkerResponseBytes(new Response('hello'))).resolves.toBe(5)
    await expect(measureWorkerResponseBytes(new Response('ignored', { headers: { 'content-length': '17' } }))).resolves.toBe(17)
  })
})
