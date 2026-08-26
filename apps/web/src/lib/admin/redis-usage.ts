export interface RedisUsageSnapshot {
  available: boolean
  totalCommands: number
  inputBytes: number
  outputBytes: number
  estimatedCostUsd: number
  sampledAt: string
  alertThresholdUsd: number | null
  maxBudgetUsd: number | null
  alertTriggered: boolean
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
export function redisUsageConfig(env: Environment = process.env) {
  return { url: firstValue(env, ['PAID_REDIS_KV_REST_API_URL', 'UPSTASH_KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL']).replace(/\/$/, ''), token: firstValue(env, ['PAID_REDIS_KV_REST_API_TOKEN', 'UPSTASH_KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN']), costPer100KCommands: costPer100KCommands(env) }
}
export function redisCostAlertThreshold(env: Environment = process.env): number | null { const configured = Number(env.REDIS_COST_ALERT_USD); return Number.isFinite(configured) && configured > 0 ? configured : null }
export function redisMaxBudget(env: Environment = process.env): number | null { const configured = Number(env.REDIS_MAX_BUDGET_USD); return Number.isFinite(configured) && configured > 0 ? configured : null }
export async function readRedisUsage(env: Environment = process.env, request: RedisRequest = (url, init) => pinnedFetch(url, init)): Promise<RedisUsageSnapshot | null> {
  const config = redisUsageConfig(env)
  if (!config.url || !config.token) return null
  try {
    const response = await request(`${config.url}/info`, { method: 'POST', headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) return null
    const body = await response.json() as RedisInfoResponse
    if (typeof body.result !== 'string') return null
    const parsed = parseRedisInfo(body.result)
    if (!parsed) return null
    const estimatedCostUsd = Number(((parsed.totalCommands / 100_000) * config.costPer100KCommands).toFixed(6))
    const alertThresholdUsd = redisCostAlertThreshold(env)
    return { available: true, ...parsed, estimatedCostUsd, sampledAt: new Date().toISOString(), alertThresholdUsd, maxBudgetUsd: redisMaxBudget(env), alertTriggered: alertThresholdUsd !== null && estimatedCostUsd >= alertThresholdUsd }
  } catch { return null }
}
import { pinnedFetch } from '@jobcopilot/shared'
