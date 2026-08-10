import { createHash } from 'node:crypto'
import { checkDistributedRateLimit, type DistributedRateLimitResult } from './distributed-rate-limit'

export type AuthRateLimitOptions = {
  ipLimit: number
  identityLimit?: number
  windowMs: number
}

/**
 * Rate-limit public authentication operations by both the edge client address
 * and the normalized account identifier. Reverse proxies must overwrite these
 * headers; hashing keeps raw addresses and email addresses out of Redis keys.
 */
export async function checkAuthRateLimit(
  request: Request,
  action: string,
  identity: string | undefined,
  options: AuthRateLimitOptions,
): Promise<DistributedRateLimitResult> {
  const client = request.headers.get('cf-connecting-ip')?.trim()
    || request.headers.get('x-real-ip')?.trim()
    || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || 'unknown'
  const ipResult = await checkDistributedRateLimit(
    'auth:' + action + ':ip:' + digest(client.slice(0, 128)),
    options.ipLimit,
    options.windowMs,
  )
  if (!ipResult.ok || !identity) return ipResult

  return checkDistributedRateLimit(
    'auth:' + action + ':identity:' + digest(identity.trim().toLowerCase()),
    options.identityLimit ?? options.ipLimit,
    options.windowMs,
  )
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}
