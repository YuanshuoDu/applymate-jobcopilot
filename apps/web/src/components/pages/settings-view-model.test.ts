import { describe, expect, it } from 'vitest'

import {
  billingSupportHref,
  billingStatusText,
  discoveryKeyClearPatch,
  EXTENSION_SETUP_HREF,
  gmailOAuthStartHref,
  isOAuthProviderAvailable,
  hasPendingSecretClear,
  matchesEmailConfirmation,
  parseSettingsTab,
  secretInputValue,
  settingsExportFilename,
  settingsTabFromHref,
  settingsTabHref,
  hasSavedDiscoveryKey,
  discoveryKeyStatusText,
} from './settings-view-model'

describe('settings view model', () => {
  it('accepts every supported deep-link tab and falls back safely', () => {
    expect(parseSettingsTab('privacy')).toBe('privacy')
    expect(parseSettingsTab('not-a-tab')).toBe('profile')
    expect(parseSettingsTab(null)).toBe('profile')
  })

  it('reads the active tab from browser history URLs', () => {
    expect(settingsTabFromHref('https://applymate.site/?page=settings&tab=privacy')).toBe('privacy')
    expect(settingsTabFromHref('https://applymate.site/?page=settings&tab=unknown')).toBe('profile')
  })

  it('links to the repository installation instructions instead of a generic store home page', () => {
    expect(EXTENSION_SETUP_HREF).toBe(
      'https://github.com/YuanshuoDu/applymate-jobcopilot/blob/main/apps/extension/EXTENSION_SETUP.md',
    )
  })

  it('keeps masked secrets until edited and represents an empty draft as a clear', () => {
    expect(secretInputValue('••••1234', undefined)).toBe('••••1234')
    expect(secretInputValue('••••1234', '')).toBe('')
    expect(hasPendingSecretClear('••••1234', '')).toBe(true)
    expect(hasPendingSecretClear('••••1234', undefined)).toBe(false)
  })

  it('builds complete clear patches for discovery credentials', () => {
    expect(discoveryKeyClearPatch('adzuna')).toEqual({ adzunaAppId: null, adzunaAppKey: null })
    expect(discoveryKeyClearPatch('rapidapi')).toEqual({ rapidapiKey: null })
  })

  it('distinguishes platform fallback credentials from user-saved credentials', () => {
    const status = {
      hasAdzuna: true,
      hasRapidapi: true,
      userHasAdzuna: false,
      userHasRapidapi: true,
      adzunaSource: 'platform' as const,
      rapidapiSource: 'user' as const,
      needsAdzunaPair: false,
    }
    expect(hasSavedDiscoveryKey(status, 'adzuna')).toBe(false)
    expect(hasSavedDiscoveryKey(status, 'rapidapi')).toBe(true)
    expect(discoveryKeyStatusText(status, 'adzuna')).toBe('platform fallback · ready')
    expect(discoveryKeyStatusText(status, 'rapidapi')).toBe('your key · ready')
  })

  it('updates only the settings tab query parameter', () => {
    expect(settingsTabHref('accounts', 'https://applymate.site/?page=settings&foo=1')).toBe(
      'https://applymate.site/?page=settings&foo=1&tab=accounts',
    )
  })

  it('creates a deterministic safe export filename', () => {
    expect(settingsExportFilename(new Date('2026-08-06T12:34:56.000Z'))).toBe('applymate-data-2026-08-06.json')
  })

  it('normalizes destructive email confirmation input', () => {
    expect(matchesEmailConfirmation(' MEMBER@EXAMPLE.COM ', 'member@example.com')).toBe(true)
    expect(matchesEmailConfirmation('other@example.com', 'member@example.com')).toBe(false)
  })

  it('creates a support mailto without pretending billing changed', () => {
    expect(billingSupportHref('support@example.com', 'upgrade to Pro')).toBe(
      'mailto:support@example.com?subject=ApplyMate%20billing%3A%20upgrade%20to%20Pro',
    )
  })

  it('describes plan assignment without claiming an unimplemented subscription renewal', () => {
    expect(billingStatusText('month', 'pro')).toEqual({
      label: 'Plan assigned',
      detail: 'Billing managed by support',
    })
    expect(billingStatusText('forever', 'free')).toEqual({
      label: 'Free plan',
      detail: 'No recurring billing configured',
    })
  })

  it('keeps the Settings accounts tab through Gmail OAuth', () => {
    expect(gmailOAuthStartHref(true)).toBe(
      '/api/gmail/oauth/start?returnTo=%2F%3Fpage%3Dsettings%26tab%3Daccounts&transfer=1',
    )
  })

  it('keeps OAuth connect actions unavailable until the platform reports readiness', () => {
    const providers = { gmail: false, github: true }
    expect(isOAuthProviderAvailable('gmail', providers)).toBe(false)
    expect(isOAuthProviderAvailable('github', providers)).toBe(true)
    expect(isOAuthProviderAvailable('linkedin', providers)).toBe(false)
  })
})
