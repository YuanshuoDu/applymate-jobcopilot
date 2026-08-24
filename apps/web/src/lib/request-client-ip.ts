import { isIP } from 'node:net'

/**
 * Return the first syntactically valid client address supplied by the proxy.
 * Never invent an address: partner APIs must receive no user_ip when the
 * deployment does not expose a trusted forwarding header.
 */
export function getClientIp(headers: Headers): string | undefined {
  const forwarded = headers.get('x-forwarded-for')
  for (const value of forwarded?.split(',') ?? []) {
    const candidate = value.trim()
    if (candidate && isIP(candidate)) return candidate
  }

  const realIp = headers.get('x-real-ip')?.trim()
  return realIp && isIP(realIp) ? realIp : undefined
}
