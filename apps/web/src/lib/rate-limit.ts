/**
 * Lightweight in-memory sliding-window rate limiter.
 *
 * Suitable for MVP / single-instance deployment.
 * Replace the Map with a Redis-backed store (e.g. ioredis + Upstash) when
 * you go multi-instance or need persistence across restarts.
 *
 * Usage:
 *   const rl = checkRateLimit(`ai:${userId}`)
 *   if (!rl.ok) return err(`Rate limit — retry in ${rl.retryAfter}s`, 429)
 */

interface Window {
  timestamps: number[]
}

// Module-level store; persists across requests within the same process.
const store = new Map<string, Window>()

/**
 * @param key        Unique key, e.g. `ai:${userId}` or `ai:score:${userId}`
 * @param limit      Max allowed requests per window (default 10)
 * @param windowMs   Rolling window in ms (default 60 000 = 1 min)
 */
export function checkRateLimit(
  key: string,
  limit   = 10,
  windowMs = 60_000,
): { ok: true } | { ok: false; retryAfter: number } {
  const now  = Date.now()
  const prev = store.get(key)?.timestamps ?? []

  // Keep only timestamps within the current window
  const recent = prev.filter(t => now - t < windowMs)

  if (recent.length >= limit) {
    // Oldest timestamp in window — tells us when a slot frees up
    const retryAfter = Math.ceil((recent[0] + windowMs - now) / 1000)
    return { ok: false, retryAfter }
  }

  recent.push(now)
  store.set(key, { timestamps: recent })
  return { ok: true }
}
