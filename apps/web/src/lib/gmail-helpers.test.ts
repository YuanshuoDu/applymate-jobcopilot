import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  accountFindFirst: vi.fn(),
  accountUpdate: vi.fn(),
  trackedFetch: vi.fn(),
  decryptAccountTokens: vi.fn(),
  encryptAccountTokenFields: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    account: {
      findFirst: mocks.accountFindFirst,
      update: mocks.accountUpdate,
    },
  },
}))
vi.mock('@/lib/api-usage/external-api-usage', () => ({ trackedExternalApiFetch: mocks.trackedFetch }))
vi.mock('@/lib/credential-secrets', () => ({
  decryptAccountTokens: mocks.decryptAccountTokens,
  encryptAccountTokenFields: mocks.encryptAccountTokenFields,
}))
vi.mock('@/lib/gmail-tracking', () => ({ classifyGmailMessage: vi.fn() }))

import { getGoogleAccessToken } from './gmail-helpers'

const account = {
  id: 'account-1',
  provider: 'gmail',
  providerAccountId: 'google-1',
  access_token: 'expired-access-token',
  accessTokenEnc: null,
  refresh_token: 'refresh-token',
  refreshTokenEnc: null,
  expires_at: Math.floor(Date.now() / 1000) - 3600,
  scope: 'https://www.googleapis.com/auth/gmail.readonly',
  token_type: 'Bearer',
  id_token: null,
  idTokenEnc: null,
  session_state: null,
}

describe('getGoogleAccessToken refresh handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.AUTH_GOOGLE_ID = 'google-client-id'
    process.env.AUTH_GOOGLE_SECRET = 'google-client-secret'
    mocks.accountFindFirst.mockResolvedValue(account)
    mocks.decryptAccountTokens.mockImplementation(async (value: typeof account) => value)
    mocks.encryptAccountTokenFields.mockResolvedValue({ accessTokenEnc: 'encrypted-access-token' })
    mocks.accountUpdate.mockResolvedValue(account)
  })

  it('returns a refreshed token and persists its expiry', async () => {
    mocks.trackedFetch.mockResolvedValue(new Response(JSON.stringify({ access_token: 'new-access-token', expires_in: 1800 }), { status: 200 }))

    await expect(getGoogleAccessToken('user-1')).resolves.toBe('new-access-token')

    expect(mocks.accountUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'account-1' },
      data: expect.objectContaining({
        accessTokenEnc: 'encrypted-access-token',
        access_token: null,
        expires_at: expect.any(Number),
      }),
    }))
  })

  it('treats revoked refresh tokens as reauthorization, not an application error', async () => {
    mocks.trackedFetch.mockResolvedValue(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(getGoogleAccessToken('user-1')).resolves.toBeNull()

    expect(warning).toHaveBeenCalledWith(
      '[gmail] Gmail connection requires reauthorization after token refresh',
      { status: 400, errorCode: 'invalid_grant' },
    )
    expect(error).not.toHaveBeenCalled()
    warning.mockRestore()
    error.mockRestore()
  })

  it('warns when an account has no access token so the UI can prompt reauthorization', async () => {
    mocks.accountFindFirst.mockResolvedValue({ ...account, access_token: null })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(getGoogleAccessToken('user-1')).resolves.toBeNull()

    expect(warning).toHaveBeenCalledWith('[gmail] Gmail connection requires reauthorization: no access token')
    warning.mockRestore()
  })
})
