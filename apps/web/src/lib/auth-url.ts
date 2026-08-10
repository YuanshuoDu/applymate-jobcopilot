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
  // Auth.js can receive a callback URL directly from an untrusted request.
  // Keep production redirects on the origin Auth.js is serving from; the
  // browser-side callbackUrl sanitizer is not an authorization boundary.
  const sameOriginTarget = target.origin === base.origin
    ? target
    : new URL(target.pathname + target.search + target.hash, base)
  const isPreviewHost = base.hostname.endsWith('.vercel.app') || target.hostname.endsWith('.vercel.app')
  if (!isPreviewHost) return sameOriginTarget.toString()
  if (preservePreview) {
    return sameOriginTarget.toString()
  }

  const canonical = safeUrl(canonicalUrl, DEFAULT_CANONICAL_URL)
  return new URL(target.pathname + target.search + target.hash, canonical).toString()
}
