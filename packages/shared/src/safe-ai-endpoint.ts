import net from 'node:net'

export type SafeAiEndpointOptions = {
  /** Allow loopback HTTP(S) endpoints for a local development server only. */
  allowLocalDevelopment?: boolean
}

/** Reject endpoint forms that can target local, metadata, or private services. */
export function isSafeAiEndpoint(raw: string, options: SafeAiEndpointOptions = {}): boolean {
  try {
    const url = new URL(raw)
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (options.allowLocalDevelopment && isLocalDevelopmentHost(host) &&
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username && !url.password && !url.hash) return true
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return false
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false
    if (host === 'metadata.google.internal' || host === 'metadata.google' || host === '169.254.169.254') return false
    if (isBlockedIp(host)) return false
    return true
  } catch {
    return false
  }
}

function isLocalDevelopmentHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) || a >= 224
}

function isBlockedIp(host: string): boolean {
  if (net.isIPv4(host)) return isPrivateIpv4(host)
  if (!net.isIPv6(host)) return false
  const mapped = host.replace(/^::ffff:/i, '')
  if (net.isIPv4(mapped)) return isPrivateIpv4(mapped)
  return host === '::' || host === '::1' || host.startsWith('fc') || host.startsWith('fd') ||
    /^fe[89ab]/i.test(host) || host.startsWith('ff') || host.startsWith('2001:db8:') || host.startsWith('64:ff9b:')
}
