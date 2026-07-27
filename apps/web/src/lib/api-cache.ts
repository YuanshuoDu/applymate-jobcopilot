interface ApiCacheEntry {
  value: unknown
}

// Client-side only: this preserves responses during in-app page switches, not
// across browser sessions. Callers still revalidate every time they mount.
const apiCache = new Map<string, ApiCacheEntry>()

function cacheKey(url: string, userId?: string | null): string {
  // API routes are almost all user-specific. Keep anonymous responses separate
  // as well so a response cannot survive a sign-in or account switch.
  return `${userId ?? 'anonymous'}\u0000${url}`
}

export function getCachedApiResponse<T>(url: string, userId?: string | null): T | null {
  return (apiCache.get(cacheKey(url, userId))?.value as T | undefined) ?? null
}

export function setCachedApiResponse<T>(url: string, value: T, userId?: string | null) {
  apiCache.set(cacheKey(url, userId), { value })
}

export function clearCachedApiResponses() {
  apiCache.clear()
}
