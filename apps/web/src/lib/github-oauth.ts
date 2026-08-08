const SETTINGS_FALLBACK = '/?page=settings&tab=accounts'

export function safeGithubReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/')) return SETTINGS_FALLBACK
  try {
    const base = 'https://applymate.invalid'
    const parsed = new URL(value, base)
    if (parsed.origin !== base) return SETTINGS_FALLBACK
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return SETTINGS_FALLBACK
  }
}

export function githubAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL('https://github.com/login/oauth/authorize')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', 'read:user user:email')
  url.searchParams.set('state', state)
  return url.toString()
}

export function githubCallbackRedirect(returnTo: string, reqUrl: string, name: string, value: string): URL {
  const target = new URL(returnTo, reqUrl)
  target.searchParams.set(name, value)
  return target
}
