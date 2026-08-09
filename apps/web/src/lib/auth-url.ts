const PRODUCTION_HOST = 'applymate.site'

export function canonicalAuthRedirect(
  url: string,
  baseUrl: string,
  canonicalUrl = 'https://' + PRODUCTION_HOST,
  preservePreview = false,
): string {
  const target = new URL(url, baseUrl)
  const base = new URL(baseUrl)
  const isPreviewHost = base.hostname.endsWith('.vercel.app') || target.hostname.endsWith('.vercel.app')
  if (!isPreviewHost) return target.toString()
  if (preservePreview) {
    return target.origin === base.origin
      ? target.toString()
      : new URL(target.pathname + target.search + target.hash, base).toString()
  }

  const canonical = new URL(canonicalUrl)
  return new URL(target.pathname + target.search + target.hash, canonical).toString()
}
