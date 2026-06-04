import { Redis } from "ioredis";
import type { RateLimitResult } from "@jobcopilot/shared";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

const MAX_PER_USER_HOUR = Number(process.env.RATE_LIMIT_PER_USER_HOUR ?? "30");
const MAX_PER_DOMAIN_4H = 5;
const HOUR_SECONDS = 60 * 60;
const FOUR_HOURS_SECONDS = 4 * HOUR_SECONDS;

async function checkRedisLimit(
  key: string,
  max: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSeconds);
  }

  if (count > max) {
    const ttl = await redis.ttl(key);
    return { allowed: false, retryAfterMs: Math.max(ttl * 1000, 1000) };
  }

  return { allowed: true };
}

/** Check per-user + per-domain rate limits.
 *  Returns the first blocking result, or { allowed: true }.
 *  @param userId - The user to check
 *  @param domain  - The company/ATS domain to check per-domain limit
 */
export async function checkRateLimit(
  userId: string,
  domain: string | null
): Promise<RateLimitResult> {
  const userResult = await checkRedisLimit(
    `ratelimit:user:${userId}`,
    MAX_PER_USER_HOUR,
    HOUR_SECONDS
  );
  if (!userResult.allowed) return userResult;

  if (domain) {
    return checkRedisLimit(
      `ratelimit:domain:${userId}:${domain}`,
      MAX_PER_DOMAIN_4H,
      FOUR_HOURS_SECONDS
    );
  }

  return { allowed: true };
}

/** Reset all rate-limit state (for tests only) */
export async function resetRateLimits(): Promise<void> {
  const keys = await redis.keys("ratelimit:*");
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}
