import type { RateLimitResult } from "@jobcopilot/shared";

interface Window {
  count: number;
  resetAt: number;
}

const userHourly = new Map<string, Window>();
const userDomain4h = new Map<string, Window>();

// TODO Phase 7: replace with Redis-backed rate limiter to survive restarts
// Current behavior: limits reset on worker restart. Acceptable for Phase 4 (low volume).
// Risk: with multiple worker instances, each has independent limits — total throughput = N * 30/hr
const MAX_PER_USER_HOUR = Number(process.env.RATE_LIMIT_PER_USER_HOUR ?? '30');
const MAX_PER_DOMAIN_4H = 5;
const HOUR_MS = 60 * 60 * 1000;
const FOUR_HOURS_MS = 4 * HOUR_MS;

function checkOrInit(
  map: Map<string, Window>,
  key: string,
  max: number,
  windowMs: number
): RateLimitResult {
  const now = Date.now();
  let w = map.get(key);
  if (!w || now >= w.resetAt) {
    w = { count: 0, resetAt: now + windowMs };
    map.set(key, w);
  }
  if (w.count >= max) {
    return { allowed: false, retryAfterMs: w.resetAt - now };
  }
  w.count++;
  return { allowed: true };
}

/** Check per-user + per-domain rate limits.
 *  Returns the first blocking result, or { allowed: true }.
 *  @param userId - The user to check
 *  @param domain  - The company/ATS domain to check per-domain limit
 */
export function checkRateLimit(
  userId: string,
  domain: string | null
): RateLimitResult {
  const userKey = `user:${userId}`;
  const userResult = checkOrInit(userHourly, userKey, MAX_PER_USER_HOUR, HOUR_MS);
  if (!userResult.allowed) return userResult;

  if (domain) {
    const domainKey = `domain:${userId}:${domain}`;
    const domainResult = checkOrInit(
      userDomain4h,
      domainKey,
      MAX_PER_DOMAIN_4H,
      FOUR_HOURS_MS
    );
    if (!domainResult.allowed) return domainResult;
  }

  return { allowed: true };
}

/** Reset all rate-limit state (for tests only) */
export function resetRateLimits(): void {
  userHourly.clear();
  userDomain4h.clear();
}

