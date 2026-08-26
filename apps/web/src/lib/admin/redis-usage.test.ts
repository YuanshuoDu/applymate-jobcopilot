import { describe, expect, it, vi } from 'vitest'
import { parseRedisInfo, readRedisUsage, redisCostAlertThreshold } from './redis-usage'

describe('redis usage', () => {
  it('parses the command counter without retaining the INFO response', () => {
    expect(parseRedisInfo('# Stats\r\ntotal_commands_processed:361030\r\n')).toBe(361030)
    expect(parseRedisInfo('# Stats\ntotal_commands_processed:not-a-number\n')).toBeNull()
  })

  it('converts the Upstash command counter to the configured pay-as-you-go estimate', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ result: '# Stats\ntotal_commands_processed:361030\n' }), { status: 200 }))
    const usage = await readRedisUsage({ PAID_REDIS_KV_REST_API_URL: 'https://redis.example.test', PAID_REDIS_KV_REST_API_TOKEN: 'server-token' }, request)
    expect(usage).toMatchObject({ available: true, totalCommands: 361030, estimatedCostUsd: 0.72206 })
    expect(request).toHaveBeenCalledWith('https://redis.example.test/info', expect.objectContaining({ method: 'POST', headers: { Authorization: 'Bearer server-token' } }))
  })

  it('does not call Redis when server credentials are not configured', async () => {
    const request = vi.fn<typeof fetch>()
    await expect(readRedisUsage({}, request)).resolves.toBeNull()
    expect(request).not.toHaveBeenCalled()
  })

  it('requires a positive configured alert threshold', () => {
    expect(redisCostAlertThreshold({ REDIS_COST_ALERT_USD: '5' })).toBe(5)
    expect(redisCostAlertThreshold({ REDIS_COST_ALERT_USD: '0' })).toBeNull()
  })
})
