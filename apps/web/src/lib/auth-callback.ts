const AUTH_BASE_URL = 'https://applymate.invalid'

export function safeCallbackUrl(value: string | null | undefined): string {
  if (!value || !value.startsWith('/')) return '/'
  try {
    const parsed = new URL(value, AUTH_BASE_URL)
    if (parsed.origin !== AUTH_BASE_URL) return '/'
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return '/'
  }
}

export function authLink(path: '/login' | '/register', callbackUrl?: string | null): string {
  const callback = safeCallbackUrl(callbackUrl)
  return callback === '/' ? path : `${path}?callbackUrl=${encodeURIComponent(callback)}`
}
