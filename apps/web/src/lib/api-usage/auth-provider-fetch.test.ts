import { describe, expect, it, vi } from 'vitest'

const trackedExternalApiFetch = vi.hoisted(() => vi.fn().mockResolvedValue(new Response('{}', { status: 200 })))
vi.mock('./external-api-usage', () => ({ trackedExternalApiFetch }))

import { authProviderFetch } from './auth-provider-fetch'

describe('authProviderFetch', () => {
  it('tracks Auth.js provider requests with safe metadata', async () => {
    const request = authProviderFetch('google-oauth')
    await request('https://oauth2.googleapis.com/token', { method: 'POST', body: 'code=redacted' })

    expect(trackedExternalApiFetch).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/token',
      expect.objectContaining({ method: 'POST', body: 'code=redacted' }),
      { provider: 'google-oauth', operation: 'nextauth', credentialSource: 'user' },
    )
  })

  it('normalizes Request inputs without exposing the Request object', async () => {
    const request = authProviderFetch('github')
    await request(new Request('https://github.com/login/oauth/access_token'))

    expect(trackedExternalApiFetch).toHaveBeenCalledWith(
      'https://github.com/login/oauth/access_token',
      expect.any(Object),
      expect.objectContaining({ provider: 'github', operation: 'nextauth' }),
    )
  })
})
