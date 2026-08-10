import net from 'node:net'
import dns from 'node:dns/promises'
import type { LookupAddress, LookupOptions } from 'node:dns'
import http from 'node:http'
import https from 'node:https'

export type PinnedFetchOptions = {
  method?: string
  headers?: unknown
  body?: unknown
  signal?: AbortSignal | null
  redirect?: string
  cache?: string
  next?: unknown
  allowLocalDevelopment?: boolean
}

type ResolvedAddress = { address: string; family: 4 | 6 }
type PinnedLookup = (
  hostname: string,
  options: LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
) => void

/**
 * Send an HTTP request through a connection pinned to the validated DNS
 * result. The hostname is retained for Host/SNI validation, while lookup is
 * forced to the address checked immediately before the socket is opened.
 */
export async function pinnedFetch(rawUrl: string | URL, init: PinnedFetchOptions = {}): Promise<Response> {
  const url = normalizeUrl(rawUrl, init.allowLocalDevelopment === true)
  const resolved = await resolveAllowedAddress(url.hostname, init.allowLocalDevelopment === true)
  const requestBody = await serializeBody(init.body)

  return new Promise<Response>((resolve, reject) => {
    const isHttps = url.protocol === 'https:'
    const lookup: PinnedLookup = (_hostname, _options, callback) => {
      callback(null, resolved.address, resolved.family)
    }
    const requestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || String(isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: init.method ?? 'GET',
      headers: requestHeaders(init.headers),
      lookup,
      agent: false,
      ...(isHttps ? { rejectUnauthorized: true, servername: net.isIP(url.hostname) ? undefined : url.hostname } : {}),
    }
    const request = isHttps
      ? https.request(requestOptions, response => {
        resolveResponse(response, resolve)
      })
      : http.request(requestOptions, response => {
        resolveResponse(response, resolve)
      })

    request.once('error', reject)
    const signal = init.signal
    if (signal) {
      const abort = () => request.destroy(new Error('Pinned outbound request aborted'))
      if (signal.aborted) {
        abort()
        return
      }
      signal.addEventListener('abort', abort, { once: true })
      request.once('close', () => signal.removeEventListener('abort', abort))
    }
    if (requestBody) request.write(requestBody)
    request.end()
  })
}

function resolveResponse(response: http.IncomingMessage, resolve: (response: Response) => void): void {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          response.on('data', chunk => controller.enqueue(new Uint8Array(chunk)))
          response.on('end', () => controller.close())
          response.on('error', error => controller.error(error))
        },
        cancel() {
          response.destroy()
        },
      })
      resolve(new Response(body, {
        status: response.statusCode ?? 502,
        statusText: response.statusMessage,
        headers: responseHeaders(response.headers),
      }))
}

export async function validatePinnedUrl(
  rawUrl: string | URL,
  options: { allowLocalDevelopment?: boolean } = {},
): Promise<URL | null> {
  try {
    const url = normalizeUrl(rawUrl, options.allowLocalDevelopment === true)
    await resolveAllowedAddress(url.hostname, options.allowLocalDevelopment === true)
    return url
  } catch {
    return null
  }
}

function normalizeUrl(rawUrl: string | URL, allowLocalDevelopment: boolean): URL {
  const url = new URL(rawUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || !url.hostname) {
    throw new Error('Outbound URL is not allowed')
  }
  if (process.env.NODE_ENV === 'production' && url.protocol === 'http:' && !allowLocalDevelopment) {
    // Preserve common legacy job links where possible, but never make a
    // plaintext connection in production. The HTTPS upgrade is validated
    // again before connecting.
    url.protocol = 'https:'
  }
  if (allowLocalDevelopment && process.env.NODE_ENV !== 'production' && isLoopbackHost(url.hostname)) return url
  if (url.protocol !== 'https:' && process.env.NODE_ENV === 'production') throw new Error('Production outbound requests require HTTPS')
  return url
}

async function resolveAllowedAddress(hostname: string, allowLocalDevelopment: boolean): Promise<ResolvedAddress> {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (isBlockedHostname(normalized) && !(allowLocalDevelopment && isLoopbackHost(normalized))) {
    throw new Error('Outbound hostname is not allowed')
  }

  const addresses = net.isIP(normalized)
    ? [{ address: normalized, family: net.isIPv4(normalized) ? 4 : 6 }]
    : await dns.lookup(normalized, { all: true, order: 'verbatim' })
  if (!(allowLocalDevelopment && isLoopbackHost(normalized)) && addresses.some(address => isBlockedIp(address.address))) {
    throw new Error('Outbound hostname resolves to a blocked address')
  }
  const valid = addresses
    .map(address => ({ address: address.address, family: address.family as 4 | 6 }))
    .filter(address => allowLocalDevelopment && isLoopbackHost(normalized) ? isLoopback(address.address) : true)
  if (valid.length === 0) throw new Error('Outbound hostname does not resolve to an allowed address')
  return valid[0]
}

function requestHeaders(input: unknown): Record<string, string> {
  const result: Record<string, string> = {}
  if (input instanceof Headers) {
    input.forEach((value, key) => { result[key] = value })
  } else if (Array.isArray(input)) {
    for (const entry of input) {
      if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && typeof entry[1] === 'string') result[entry[0]] = entry[1]
    }
  } else if (input && typeof input === 'object') {
    for (const [key, value] of Object.entries(input)) {
      if (typeof value === 'string') result[key] = value
    }
  }
  return result
}

async function serializeBody(body: unknown): Promise<string | Uint8Array | null> {
  if (body == null) return null
  if (typeof body === 'string' || body instanceof Uint8Array) return body
  if (body instanceof URLSearchParams) return body.toString()
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  throw new Error('Pinned outbound client does not support this request body')
}

function responseHeaders(input: http.IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) result[key] = value.join(', ')
    else if (typeof value === 'string') result[key] = value
  }
  return result
}

function isBlockedHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname === 'metadata.google.internal'
    || hostname === 'metadata.google'
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

function isLoopback(address: string): boolean {
  return address === '127.0.0.1' || address === '::1'
}

function isBlockedIp(address: string): boolean {
  const normalized = address.toLowerCase()
  if (net.isIPv4(normalized)) {
    const [first, second, third] = normalized.split('.').map(Number)
    return first === 0 || first === 10 || first === 127 || first >= 224
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && (second === 0 || second === 168))
      || (first === 192 && second === 0 && third === 2)
      || (first === 192 && second === 88 && third === 99)
      || (first === 198 && (second === 18 || second === 19 || second === 51))
      || (first === 203 && second === 0 && third === 113)
  }
  if (!net.isIPv6(normalized)) return true
  const mapped = normalized.replace(/^::ffff:/, '')
  if (net.isIPv4(mapped)) return isBlockedIp(mapped)
  return normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith('ff')
    || normalized.startsWith('2001:db8:')
    || normalized.startsWith('64:ff9b:')
}
