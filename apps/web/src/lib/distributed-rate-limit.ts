import { Redis } from 'ioredis'
import { checkRateLimit } from '@/lib/rate-limit'

export type DistributedRateLimitResult =
  | { ok: true }
  | { ok: false; retryAfter: number; unavailable?: true }

let redisClient: Redis | null = null
let redisUrl: string | null = null

const incrementWithExpiry = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
`

function unavailable(windowMs: number): DistributedRateLimitResult {
  return { ok: false, retryAfter: Math.max(1, Math.ceil(windowMs / 1_000)), unavailable: true }
}

function getRedisClient(): Redis | null {
  const url = process.env.REDIS_URL?.trim()
  if (!url) return null

  if (!redisClient || redisUrl !== url) {
    redisClient?.disconnect()
    redisClient = new Redis(url, {
      connectTimeout: 1_000,
      enableReadyCheck: false,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    })
    // Connection failures are returned to the caller as a safe 503 response.
    redisClient.on('error', () => {})
    redisUrl = url
  }

  return redisClient
}

/**
 * Enforces a fixed-window limit shared by all web instances. Production calls
 * fail closed when Redis is unavailable so paid provider probes cannot bypass
 * cost controls through a cold start or a second serverless instance.
 */
export async function checkDistributedRateLimit(
  key: string,
  limit = 10,
  windowMs = 60_000,
): Promise<DistributedRateLimitResult> {
  const client = getRedisClient()
  if (!client) {
    return process.env.NODE_ENV === 'production'
      ? unavailable(windowMs)
      : checkRateLimit(key, limit, windowMs)
  }

  const redisKey = `rate-limit:${key}`
  try {
    // Redis executes the increment and first-window TTL as one operation.
    const count = await client.eval(incrementWithExpiry, 1, redisKey, windowMs)
    if (typeof count !== 'number') throw new Error('Unexpected Redis counter response')
    if (count <= limit) return { ok: true }

    const ttl = await client.pttl(redisKey)
    return { ok: false, retryAfter: Math.max(1, Math.ceil((ttl > 0 ? ttl : windowMs) / 1_000)) }
  } catch {
    return unavailable(windowMs)
  }
}
