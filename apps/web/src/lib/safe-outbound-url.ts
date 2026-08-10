import dns from 'node:dns/promises'
import net from 'node:net'

const MAX_TEXT_BYTES = 2 * 1024 * 1024

/** Fetch user-influenced job pages without allowing private-network access. */
export async function fetchExternalText(rawUrl: string, init: RequestInit = {}, maxBytes = MAX_TEXT_BYTES): Promise<string | null> {
  const url = await validateExternalUrl(rawUrl)
  if (!url) return null

  try {
    const response = await fetch(url, { ...init, redirect: 'error' })
    if (!response.ok || !response.body) return null
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        return null
      }
      chunks.push(next.value)
    }
    const body = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder().decode(body)
  } catch {
    return null
  }
}

export async function validateExternalUrl(rawUrl: string): Promise<URL | null> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) return null

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (isBlockedHostname(hostname)) return null
  const addresses = net.isIP(hostname)
    ? [hostname]
    : await dns.lookup(hostname, { all: true, verbatim: true }).then(rows => rows.map(row => row.address)).catch(() => [])
  if (addresses.length === 0 || addresses.some(isBlockedIp)) return null
  return url
}

function isBlockedHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname === 'metadata.google.internal'
}

function isBlockedIp(address: string): boolean {
  const normalized = address.toLowerCase()
  if (net.isIPv4(normalized)) {
    const octets = normalized.split('.').map(Number)
    const [first, second] = octets
    return first === 0 || first === 10 || first === 127 || first >= 224
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && (second === 0 || second === 168))
      || (first === 198 && (second === 18 || second === 19))
      || (first === 203 && second === 0)
  }
  if (!net.isIPv6(normalized)) return true
  const compact = normalized.replace(/^::ffff:/, '')
  if (net.isIPv4(compact)) return isBlockedIp(compact)
  return normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb')
    || normalized.startsWith('ff')
    || normalized.startsWith('2001:db8:')
}
