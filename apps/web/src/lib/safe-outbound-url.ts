import { pinnedFetch, validatePinnedUrl } from '@jobcopilot/shared'

const MAX_TEXT_BYTES = 2 * 1024 * 1024

/** Fetch user-influenced job pages through the DNS-pinned outbound client. */
export async function fetchExternalText(rawUrl: string, init: RequestInit = {}, maxBytes = MAX_TEXT_BYTES): Promise<string | null> {
  try {
    const response = await pinnedFetch(rawUrl, { ...init, redirect: 'error' })
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
  return validatePinnedUrl(rawUrl)
}
