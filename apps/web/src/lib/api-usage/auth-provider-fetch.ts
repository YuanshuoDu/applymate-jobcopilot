import type { PinnedFetchOptions } from '@jobcopilot/shared'
import { trackedExternalApiFetch } from './external-api-usage'

type AuthProvider = 'google-oauth' | 'github'

/** Track Auth.js provider HTTP calls without recording OAuth payloads. */
export function authProviderFetch(provider: AuthProvider) {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' || input instanceof URL ? input : input.url
    return trackedExternalApiFetch(url, (init ?? {}) as PinnedFetchOptions, {
      provider,
      operation: 'nextauth',
      credentialSource: 'user',
    })
  }
}
