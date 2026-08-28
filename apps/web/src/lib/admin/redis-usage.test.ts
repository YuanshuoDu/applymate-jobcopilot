import { describe, expect, it, vi } from 'vitest'
import { parseRedisInfo, parseRedisManagementMetrics, parseRedisManagementStats, readRedisUsage, redisCostAlertThreshold, redisMaxBudget, redisUsageConfig } from './redis-usage'

describe('redis usage', () => {
  it('parses counters without retaining the INFO response', () => {
    expect(parseRedisInfo('# Stats\r\ntotal_commands_processed:361030\r\ntotal_net_input_bytes:11\r\ntotal_net_output_bytes:22\r\n')).toEqual({ totalCommands: 361030, inputBytes: 11, outputBytes: 22 })
    expect(parseRedisInfo('# Stats\ntotal_commands_processed:not-a-number\n')).toBeNull()
  })
  it('parses the current-month management stats returned by Upstash', () => {
    const stats = { total_monthly_requests: 362926, total_monthly_read_requests: 300000, total_monthly_write_requests: 60000, total_monthly_script_requests: 2926, total_monthly_bandwidth: 4096, total_monthly_billing: 0.725852 }
    expect(parseRedisManagementStats(stats)).toEqual({ totalCommands: 362926, inputBytes: 0, outputBytes: 4096, estimatedCostUsd: 0.725852 })
    expect(parseRedisManagementMetrics(stats)).toEqual([
      { name: 'read_requests', value: 300000, unit: 'requests', estimatedCostUsd: null },
      { name: 'write_requests', value: 60000, unit: 'requests', estimatedCostUsd: null },
      { name: 'script_requests', value: 2926, unit: 'requests', estimatedCostUsd: null },
    ])
    expect(parseRedisManagementStats({ total_monthly_requests: 'not-a-number' })).toBeNull()
  })
  it('converts Upstash commands to a pay-as-you-go estimate', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ result: '# Stats\ntotal_commands_processed:361030\n' }), { status: 200 }))
    await expect(readRedisUsage({ PAID_REDIS_KV_REST_API_URL: 'https://redis-lifetime.example.test', PAID_REDIS_KV_REST_API_TOKEN: 'server-token', REDIS_COST_ALERT_USD: '5', REDIS_MAX_BUDGET_USD: '20' }, request)).resolves.toMatchObject({ totalCommands: 361030, estimatedCostUsd: 0.72206, period: 'instance_lifetime', source: 'upstash_rest_info', alertThresholdUsd: 5, maxBudgetUsd: 20, alertTriggered: false })
    expect(request).toHaveBeenCalledWith('https://redis-lifetime.example.test/info', expect.objectContaining({ method: 'POST' }))
  })
  it('does not treat the lifetime INFO estimate as a monthly alert', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ result: '# Stats\ntotal_commands_processed:2500000\n' }), { status: 200 }))
    await expect(readRedisUsage({ PAID_REDIS_KV_REST_API_URL: 'https://redis-alert.example.test', PAID_REDIS_KV_REST_API_TOKEN: 'server-token', REDIS_COST_ALERT_USD: '5' }, request)).resolves.toMatchObject({ period: 'instance_lifetime', estimatedCostUsd: 5, alertTriggered: false })
  })
  it('reuses a successful INFO snapshot within the configured TTL', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ result: '# Stats\ntotal_commands_processed:7\n' }), { status: 200 }))
    const env = { PAID_REDIS_KV_REST_API_URL: 'https://redis-cache.example.test', PAID_REDIS_KV_REST_API_TOKEN: 'server-token', REDIS_INFO_CACHE_TTL_SECONDS: '600', REDIS_COST_ALERT_USD: '5' }
    const first = await readRedisUsage(env, request)
    const second = await readRedisUsage({ ...env, REDIS_COST_ALERT_USD: '1' }, request)
    expect(request).toHaveBeenCalledTimes(1)
    expect(second).toMatchObject({ totalCommands: 7, alertThresholdUsd: 1, sampledAt: first?.sampledAt })
  })
  it('can disable the INFO fallback to avoid any Redis command', async () => {
    const request = vi.fn<typeof fetch>()
    await expect(readRedisUsage({ PAID_REDIS_KV_REST_API_URL: 'https://redis-disabled.example.test', PAID_REDIS_KV_REST_API_TOKEN: 'server-token', REDIS_INFO_FALLBACK_ENABLED: '0' }, request)).resolves.toBeNull()
    expect(request).not.toHaveBeenCalled()
  })
  it('prefers current-month stats when management credentials are configured', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ total_monthly_requests: 362926, total_monthly_read_requests: 300000, total_monthly_bandwidth: 4096, total_monthly_billing: 0.725852 }), { status: 200 }))
    await expect(readRedisUsage({ PAID_REDIS_DATABASE_ID: 'db-1', UPSTASH_API_EMAIL: 'owner@example.com', UPSTASH_API_KEY: 'management-key', REDIS_COST_ALERT_USD: '0.70', REDIS_MAX_BUDGET_USD: '20' }, request)).resolves.toMatchObject({ totalCommands: 362926, estimatedCostUsd: 0.725852, period: 'current_month', source: 'upstash_management_stats', alertTriggered: true, metrics: [{ name: 'read_requests', value: 300000, unit: 'requests' }] })
    expect(request).toHaveBeenCalledWith('https://api.upstash.com/v2/redis/stats/db-1', expect.objectContaining({ method: 'GET', headers: { Authorization: `Basic ${Buffer.from('owner@example.com:management-key').toString('base64')}` } }))
  })
  it('does not call Redis without server credentials', async () => { const request = vi.fn<typeof fetch>(); await expect(readRedisUsage({}, request)).resolves.toBeNull(); expect(request).not.toHaveBeenCalled() })
  it('accepts a positive application alert and budget cap', () => { expect(redisCostAlertThreshold({ REDIS_COST_ALERT_USD: '5' })).toBe(5); expect(redisMaxBudget({ REDIS_MAX_BUDGET_USD: '20' })).toBe(20) })
  it('prefers the read-only integration token for usage snapshots', () => {
    expect(redisUsageConfig({ PAID_REDIS_KV_REST_API_READ_ONLY_TOKEN: 'read-only', PAID_REDIS_KV_REST_API_TOKEN: 'write-capable' }).token).toBe('read-only')
  })
  it('tries the same-host Redis URL password when the read-only token is unavailable', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: '# Stats\ntotal_commands_processed:637273\n' }), { status: 200 }))
    await expect(readRedisUsage({
      PAID_REDIS_KV_REST_API_URL: 'https://redis-prod-binding.example.test',
      PAID_REDIS_KV_REST_API_READ_ONLY_TOKEN: 'unavailable-token',
      PAID_REDIS_REDIS_URL: 'rediss://default:redis%2Fpassword@redis-prod-binding.example.test:6379',
      REDIS_COST_PER_100K_COMMANDS: '0.2',
    }, request)).resolves.toMatchObject({ totalCommands: 637273, period: 'instance_lifetime', source: 'upstash_rest_info' })
    expect(request).toHaveBeenNthCalledWith(2, 'https://redis-prod-binding.example.test/info', expect.objectContaining({ headers: { Authorization: 'Bearer redis/password' } }))
  })
})
