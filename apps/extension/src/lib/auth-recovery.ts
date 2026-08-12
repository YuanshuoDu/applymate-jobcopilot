export function isAuthFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error
    ? (error as { status?: unknown }).status === 401
    : /unauthorized|session expired|account unavailable/i.test(error instanceof Error ? error.message : String(error))
}

export function isApplyMateDashboardUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false
  try {
    const url = new URL(rawUrl)
    return url.protocol === 'https:' && url.hostname === 'applymate.site'
  } catch {
    return false
  }
}
