interface ApiCacheEntry {
  value: unknown
}

// Client-side only: this preserves responses during in-app page switches, not
// across browser sessions. Callers still revalidate every time they mount.
const apiCache = new Map<string, ApiCacheEntry>()

export function getCachedApiResponse<T>(url: string): T | null {
  return (apiCache.get(url)?.value as T | undefined) ?? null
}

export function setCachedApiResponse<T>(url: string, value: T) {
  apiCache.set(url, { value })
}

export function clearCachedApiResponses() {
  apiCache.clear()
}
