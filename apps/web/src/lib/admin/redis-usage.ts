export interface RedisUsageSnapshot {
  available: boolean
  totalCommands: number
  estimatedCostUsd: number
  sampledAt: string
}

type RedisInfoResponse = { result?: unknown }
type Environment = Record<string, string | undefined>

const DEFAULT_COST_PER_100K_COMMANDS = 0.2

function firstValue(env: Environment, names: string[]) {
  return names.map((name) => env[name]?.trim()).find(Boolean) ?? ''
}

function costPer100KCommands(env: Environment) {
  const configured = Number(env.REDIS_COST_PER_100K_COMMANDS)
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_COST_PER_100K_COMMANDS
}

export function parseRedisInfo(info: string): number | null {
  const match = info.match(/(?:^|\n)total_commands_processed:(\d+)(?:\r?\n|$)/)
  if (!match) return null
  const commands = Number(match[1])
  return Number.isSafeInteger(commands) && commands >= 0 ? commands : null
}

export function redisUsageConfig(env: Environment = process.env) {
  return {
    url: firstValue(env, ['PAID_REDIS_KV_REST_API_URL', 'UPSTASH_KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL']).replace(/\/$/, ''),
    token: firstValue(env, ['PAID_REDIS_KV_REST_API_TOKEN', 'UPSTASH_KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN']),
    costPer100KCommands: costPer100KCommands(env),
  }
}

export function redisCostAlertThreshold(env: Environment = process.env) {
  const configured = Number(env.REDIS_COST_ALERT_USD)
  return Number.isFinite(configured) && configured > 0 ? configured : null
}

export async function readRedisUsage(
  env: Environment = process.env,
  request: typeof fetch = fetch,
): Promise<RedisUsageSnapshot | null> {
  const config = redisUsageConfig(env)
  if (!config.url || !config.token) return null

  try {
    const response = await request(`${config.url}/info`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return null
    const body = await response.json() as RedisInfoResponse
    if (typeof body.result !== 'string') return null
    const totalCommands = parseRedisInfo(body.result)
    if (totalCommands === null) return null
    return {
      available: true,
      totalCommands,
      estimatedCostUsd: Number(((totalCommands / 100_000) * config.costPer100KCommands).toFixed(6)),
      sampledAt: new Date().toISOString(),
    }
  } catch {
    return null
  }
}
