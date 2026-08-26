export interface RedisUsageSnapshot {
  available: boolean
  totalCommands: number
  inputBytes: number
  outputBytes: number
  estimatedCostUsd: number
  sampledAt: string
  period: 'current_month' | 'instance_lifetime'
  source: 'upstash_management_stats' | 'upstash_rest_info'
  alertThresholdUsd: number | null
  maxBudgetUsd: number | null
  alertTriggered: boolean
  metrics: Array<{ name: 'read_requests' | 'write_requests' | 'script_requests'; value: number; unit: 'requests'; estimatedCostUsd: null }>
}
type Environment = Record<string, string | undefined>
type RedisInfoResponse = { result?: unknown }
type RedisRequest = (url: string, init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>
const DEFAULT_COST_PER_100K_COMMANDS = 0.2

function firstValue(env: Environment, names: string[]): string { return names.map(name => env[name]?.trim()).find(Boolean) ?? '' }
function costPer100KCommands(env: Environment): number { const configured = Number(env.REDIS_COST_PER_100K_COMMANDS); return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_COST_PER_100K_COMMANDS }
function infoNumber(info: string, key: string): number { const match = info.match(new RegExp(`(?:^|\\n)${key}:(\\d+)(?:\\r?\\n|$)`)); const value = Number(match?.[1] ?? 0); return Number.isSafeInteger(value) && value >= 0 ? value : 0 }
export function parseRedisInfo(info: string): Pick<RedisUsageSnapshot, 'totalCommands' | 'inputBytes' | 'outputBytes'> | null {
  if (!/(?:^|\n)total_commands_processed:\d+(?:\r?\n|$)/.test(info)) return null
  return { totalCommands: infoNumber(info, 'total_commands_processed'), inputBytes: infoNumber(info, 'total_net_input_bytes'), outputBytes: infoNumber(info, 'total_net_output_bytes') }
}
type RedisManagementStats = {
  total_monthly_requests?: unknown
  total_monthly_read_requests?: unknown
  total_monthly_write_requests?: unknown
  total_monthly_script_requests?: unknown
  total_monthly_bandwidth?: unknown
  total_monthly_billing?: unknown
}
function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}
function nonNegativeNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}
export function parseRedisManagementStats(value: unknown): Pick<RedisUsageSnapshot, 'totalCommands' | 'inputBytes' | 'outputBytes' | 'estimatedCostUsd'> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const stats = value as RedisManagementStats
  const totalCommands = positiveInteger(stats.total_monthly_requests)
  const bandwidth = positiveInteger(stats.total_monthly_bandwidth)
  const billing = nonNegativeNumber(stats.total_monthly_billing)
  if (totalCommands === null || bandwidth === null || billing === null) return null
  return { totalCommands, inputBytes: 0, outputBytes: bandwidth, estimatedCostUsd: Number(billing.toFixed(6)) }
}

export function parseRedisManagementMetrics(value: unknown): RedisUsageSnapshot['metrics'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const stats = value as RedisManagementStats
  return [
    ['read_requests', stats.total_monthly_read_requests],
    ['write_requests', stats.total_monthly_write_requests],
    ['script_requests', stats.total_monthly_script_requests],
  ].flatMap(([name, raw]) => {
    const parsed = positiveInteger(raw)
    return parsed === null ? [] : [{ name: name as RedisUsageSnapshot['metrics'][number]['name'], value: parsed, unit: 'requests' as const, estimatedCostUsd: null }]
  })
}
export function redisUsageConfig(env: Environment = process.env) {
  return {
    url: firstValue(env, ['PAID_REDIS_KV_REST_API_URL', 'UPSTASH_KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL']).replace(/\/$/, ''),
    token: firstValue(env, ['PAID_REDIS_KV_REST_API_TOKEN', 'UPSTASH_KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN']),
    databaseId: firstValue(env, ['PAID_REDIS_DATABASE_ID', 'UPSTASH_REDIS_DATABASE_ID']),
    managementEmail: firstValue(env, ['UPSTASH_API_EMAIL']),
    managementKey: firstValue(env, ['UPSTASH_API_KEY']),
    costPer100KCommands: costPer100KCommands(env),
  }
}
export function redisCostAlertThreshold(env: Environment = process.env): number | null { const configured = Number(env.REDIS_COST_ALERT_USD); return Number.isFinite(configured) && configured > 0 ? configured : null }
export function redisMaxBudget(env: Environment = process.env): number | null { const configured = Number(env.REDIS_MAX_BUDGET_USD); return Number.isFinite(configured) && configured > 0 ? configured : null }
export async function readRedisUsage(env: Environment = process.env, request: RedisRequest = (url, init) => pinnedFetch(url, init)): Promise<RedisUsageSnapshot | null> {
  const config = redisUsageConfig(env)
  const alertThresholdUsd = redisCostAlertThreshold(env)
  const maxBudgetUsd = redisMaxBudget(env)
  if (config.databaseId && config.managementEmail && config.managementKey) {
    try {
      const response = await request(`https://api.upstash.com/v2/redis/stats/${encodeURIComponent(config.databaseId)}`, {
        method: 'GET',
        headers: { Authorization: `Basic ${Buffer.from(`${config.managementEmail}:${config.managementKey}`).toString('base64')}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (response.ok) {
        const body = await response.json()
        const parsed = parseRedisManagementStats(body)
        if (parsed) return { available: true, ...parsed, sampledAt: new Date().toISOString(), period: 'current_month', source: 'upstash_management_stats', alertThresholdUsd, maxBudgetUsd, alertTriggered: alertThresholdUsd !== null && parsed.estimatedCostUsd >= alertThresholdUsd, metrics: parseRedisManagementMetrics(body) }
      }
    } catch { /* Fall back to the database REST INFO endpoint below. */ }
  }
  if (!config.url || !config.token) return null
  try {
    const response = await request(`${config.url}/info`, { method: 'POST', headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) return null
    const body = await response.json() as RedisInfoResponse
    if (typeof body.result !== 'string') return null
    const parsed = parseRedisInfo(body.result)
    if (!parsed) return null
    const estimatedCostUsd = Number(((parsed.totalCommands / 100_000) * config.costPer100KCommands).toFixed(6))
    // INFO exposes an instance-lifetime counter, so it cannot prove a monthly
    // budget breach. Keep the estimate visible, but defer alerting to the
    // current-month management-stats path.
    return { available: true, ...parsed, estimatedCostUsd, sampledAt: new Date().toISOString(), period: 'instance_lifetime', source: 'upstash_rest_info', alertThresholdUsd, maxBudgetUsd, alertTriggered: false, metrics: [] }
  } catch { return null }
}
import { pinnedFetch } from '@jobcopilot/shared'
