import { describe, expect, it, vi } from 'vitest'
import { parseRedisInfo, readRedisUsage, redisCostAlertThreshold, redisMaxBudget } from './redis-usage'

describe('redis usage', () => {
  it('parses counters without retaining the INFO response', () => {
    expect(parseRedisInfo('# Stats\r\ntotal_commands_processed:361030\r\ntotal_net_input_bytes:11\r\ntotal_net_output_bytes:22\r\n')).toEqual({ totalCommands: 361030, inputBytes: 11, outputBytes: 22 })
    expect(parseRedisInfo('# Stats\ntotal_commands_processed:not-a-number\n')).toBeNull()
  })
  it('converts Upstash commands to a pay-as-you-go estimate', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ result: '# Stats\ntotal_commands_processed:361030\n' }), { status: 200 }))
    await expect(readRedisUsage({ PAID_REDIS_KV_REST_API_URL: 'https://redis.example.test', PAID_REDIS_KV_REST_API_TOKEN: 'server-token', REDIS_COST_ALERT_USD: '5', REDIS_MAX_BUDGET_USD: '20' }, request)).resolves.toMatchObject({ totalCommands: 361030, estimatedCostUsd: 0.72206, alertThresholdUsd: 5, maxBudgetUsd: 20, alertTriggered: false })
    expect(request).toHaveBeenCalledWith('https://redis.example.test/info', expect.objectContaining({ method: 'POST' }))
  })
  it('does not call Redis without server credentials', async () => { const request = vi.fn<typeof fetch>(); await expect(readRedisUsage({}, request)).resolves.toBeNull(); expect(request).not.toHaveBeenCalled() })
  it('accepts a positive application alert and budget cap', () => { expect(redisCostAlertThreshold({ REDIS_COST_ALERT_USD: '5' })).toBe(5); expect(redisMaxBudget({ REDIS_MAX_BUDGET_USD: '20' })).toBe(20) })
})
