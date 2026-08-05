const PRODUCTION_HOST = 'applymate.site'

export function canonicalAuthRedirect(url: string, baseUrl: string, canonicalUrl = 'https://' + PRODUCTION_HOST): string {
  const target = new URL(url, baseUrl)
  const base = new URL(baseUrl)
  const isPreviewHost = base.hostname.endsWith('.vercel.app') || target.hostname.endsWith('.vercel.app')
  if (!isPreviewHost) return target.toString()

  const canonical = new URL(canonicalUrl)
  return new URL(target.pathname + target.search + target.hash, canonical).toString()
}
