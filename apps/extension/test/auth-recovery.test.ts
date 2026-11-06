import { describe, expect, it, vi } from 'vitest'
import { isApplyMateDashboardUrl, isAuthFailure, isSameRecoveryAccount, withAccountAuthRecovery } from '../src/lib/auth-recovery'
import type { ExtensionSettings } from '../src/lib/types'

describe('extension auth recovery', () => {
  it('accepts only the production candidate dashboard origin', () => {
    expect(isApplyMateDashboardUrl('https://applymate.site/?page=jobs')).toBe(true)
    expect(isApplyMateDashboardUrl('https://admin.applymate.site/admin')).toBe(false)
    expect(isApplyMateDashboardUrl('https://applymate.site.evil.example/')).toBe(false)
    expect(isApplyMateDashboardUrl('http://applymate.site/')).toBe(false)
  })

  it('recognizes expired bearer sessions without treating normal errors as auth failures', () => {
    expect(isAuthFailure({ status: 401 })).toBe(true)
    expect(isAuthFailure(new Error('Session expired'))).toBe(true)
    expect(isAuthFailure({ status: 403 })).toBe(false)
    expect(isAuthFailure(new Error('Network timeout'))).toBe(false)
  })
})

describe('account-bound request recovery', () => {
  const original: ExtensionSettings = { apiBaseUrl: 'https://applymate.site', apiToken: 'old-token', userEmail: 'a@example.test', userName: 'Candidate A', autoSave: false }
  const authError = { status: 401 }

  it.each([
    { userEmail: 'b@example.test' }, { apiBaseUrl: 'http://localhost:3000' }, { userEmail: '' },
  ])('never replays an authenticated payload with a different or unknown identity: %o', changed => {
    const operation = vi.fn().mockRejectedValueOnce(authError)
    const refresh = vi.fn().mockResolvedValue({ ...original, apiToken: 'new-token', ...changed })
    return expect(withAccountAuthRecovery(original, refresh, operation)).rejects.toBe(authError).then(() => {
      expect(operation).toHaveBeenCalledExactlyOnceWith(original)
    })
  })

  it('retries once with the same normalized account and retains the original payload', async () => {
    const payload = { title: 'Original account job', notes: 'Original account notes' }
    const request = vi.fn().mockRejectedValueOnce(authError).mockResolvedValueOnce({ saved: true })
    const refreshed = { ...original, apiToken: 'new-token', userEmail: ' A@example.test ' }
    await expect(withAccountAuthRecovery(original, async () => refreshed, selected => request(selected, payload))).resolves.toEqual({ saved: true })
    expect(request).toHaveBeenNthCalledWith(1, original, payload)
    expect(request).toHaveBeenNthCalledWith(2, refreshed, payload)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('does not infer continuity from a token without an original account email', async () => {
    const operation = vi.fn().mockRejectedValueOnce(authError)
    await expect(withAccountAuthRecovery({ ...original, userEmail: '' }, async () => ({ ...original, apiToken: 'new-token' }), operation)).rejects.toBe(authError)
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it.each(['', 'a@example.test'])('does not send a no-token operation when refresh first selects a different account (old email: %s)', async userEmail => {
    const operation = vi.fn()
    const connected = { ...original, apiToken: 'b-token', userEmail: 'b@example.test' }
    await expect(withAccountAuthRecovery({ ...original, apiToken: '', userEmail }, async () => connected, operation)).rejects.toThrow(/Check the selected account/)
    expect(operation).not.toHaveBeenCalled()
  })

  it('can reconnect a previously selected account before sending its first request', async () => {
    const refreshed = { ...original, apiToken: 'fresh-token' }
    const operation = vi.fn().mockResolvedValue('saved')
    await expect(withAccountAuthRecovery({ ...original, apiToken: '' }, async () => refreshed, operation)).resolves.toBe('saved')
    expect(operation).toHaveBeenCalledExactlyOnceWith(refreshed)
  })

  it('does not resend an unchanged rejected token', async () => {
    const operation = vi.fn().mockRejectedValueOnce(authError)
    await expect(withAccountAuthRecovery(original, async () => original, operation)).rejects.toBe(authError)
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('does not refresh or retry non-authentication failures', async () => {
    const error = new Error('Network error')
    const refresh = vi.fn()
    const operation = vi.fn().mockRejectedValueOnce(error)
    await expect(withAccountAuthRecovery(original, refresh, operation)).rejects.toBe(error)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('requires both a real identity and the same API origin', () => {
    expect(isSameRecoveryAccount(original, { ...original, userEmail: ' A@example.test ' })).toBe(true)
    expect(isSameRecoveryAccount({ ...original, userEmail: ' ' }, { ...original, userEmail: '' })).toBe(false)
    expect(isSameRecoveryAccount(original, { ...original, apiBaseUrl: 'http://localhost:3000' })).toBe(false)
    expect(isSameRecoveryAccount(undefined, original)).toBe(false)
  })
})
