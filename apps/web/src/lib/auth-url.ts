const PRODUCTION_HOST = 'applymate.site'
const DEFAULT_CANONICAL_URL = `https://${PRODUCTION_HOST}`

function safeUrl(value: string | undefined, fallback: string): URL {
  try {
    return new URL(value ?? fallback)
  } catch {
    return new URL(fallback)
  }
}

export function canonicalAuthRedirect(
  url: string,
  baseUrl: string,
  canonicalUrl = DEFAULT_CANONICAL_URL,
  preservePreview = false,
): string {
  const base = safeUrl(baseUrl, DEFAULT_CANONICAL_URL)
  const target = new URL(url, base)
  const isPreviewHost = base.hostname.endsWith('.vercel.app') || target.hostname.endsWith('.vercel.app')
  if (!isPreviewHost) return target.toString()
  if (preservePreview) {
    return target.origin === base.origin
      ? target.toString()
      : new URL(target.pathname + target.search + target.hash, base).toString()
  }

  const canonical = safeUrl(canonicalUrl, DEFAULT_CANONICAL_URL)
  return new URL(target.pathname + target.search + target.hash, canonical).toString()
}
