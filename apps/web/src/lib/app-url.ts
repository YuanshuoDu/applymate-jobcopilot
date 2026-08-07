/**
 * Resolve the public origin used by callbacks and outbound links.
 * Explicit configuration wins because request URLs can reflect a proxy or
 * preview host that is not registered with an OAuth provider.
 */
export function configuredAppOrigin(requestUrl: string): string {
  const configured = [process.env.AUTH_URL, process.env.NEXTAUTH_URL, process.env.APP_URL]
    .map(value => value?.trim())
    .find(Boolean)

  if (configured) {
    try {
      const url = new URL(configured)
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin
    } catch {
      // Fall through to the request origin for development and recovery.
    }
  }

  return new URL(requestUrl).origin
}

export function configuredRedirectUri(requestUrl: string, pathname: string): string {
  return new URL(pathname, configuredAppOrigin(requestUrl)).toString()
}
