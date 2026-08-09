const DEFAULT_ADMIN_HOST = 'admin.applymate.site'
const configuredAdminHost = process.env.ADMIN_HOST?.trim().toLowerCase()

export const ADMIN_HOST = configuredAdminHost || DEFAULT_ADMIN_HOST

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/:\d+$/, '')
}

export function isAdminHost(hostname: string): boolean {
  return normalizeHostname(hostname) === ADMIN_HOST
}

export function isAdminPath(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/')
}

export function isAuthPath(pathname: string): boolean {
  return pathname === '/login'
    || pathname.startsWith('/login/')
    || pathname === '/forgot-password'
    || pathname.startsWith('/forgot-password/')
    || pathname === '/reset-password'
    || pathname.startsWith('/reset-password/')
    || pathname === '/api/auth'
    || pathname.startsWith('/api/auth/')
}

export function isAdminApiPath(pathname: string): boolean {
  return pathname === '/api/admin/v1' || pathname.startsWith('/api/admin/v1/')
}

export function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(normalizeHostname(hostname))
}

export function adminOrigin(requestUrl: string): string {
  const configured = process.env.ADMIN_APP_URL?.trim()
  if (configured) {
    try {
      const url = new URL(configured)
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin
    } catch {
      // Fall through to the configured host and request protocol.
    }
  }

  const request = new URL(requestUrl)
  return `${request.protocol}//${ADMIN_HOST}`
}
