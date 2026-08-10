import { describe, expect, it } from 'vitest'

import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  DEFAULT_PRIVACY_PREFERENCES,
  hasActiveDeletionRequest,
  mergeUserPreferences,
  readNotificationPreferences,
  readPrivacyPreferences,
  validateAvatarValue,
} from './settings-preferences'

describe('settings preference helpers', () => {
  it('returns stable defaults when stored preferences are absent or malformed', () => {
    expect(readNotificationPreferences(null)).toEqual(DEFAULT_NOTIFICATION_PREFERENCES)
    expect(readPrivacyPreferences({})).toEqual(DEFAULT_PRIVACY_PREFERENCES)
    expect(readNotificationPreferences({ notificationPreferences: { apply: false } })).toEqual({
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      apply: false,
    })
  })

  it('only treats requested or processing deletion requests as active', () => {
    expect(hasActiveDeletionRequest({ dataDeletionRequestedAt: '2026-08-06T00:00:00.000Z', dataDeletionRequestStatus: 'requested' })).toBe(true)
    expect(hasActiveDeletionRequest({ dataDeletionRequestedAt: '2026-08-06T00:00:00.000Z', dataDeletionRequestStatus: 'processing' })).toBe(true)
    expect(hasActiveDeletionRequest({ dataDeletionRequestedAt: '2026-08-06T00:00:00.000Z', dataDeletionRequestStatus: 'completed' })).toBe(false)
    expect(hasActiveDeletionRequest({ dataDeletionRequestedAt: '2026-08-06T00:00:00.000Z' })).toBe(false)
  })

  it('merges supplied settings without deleting AI or future preference keys', () => {
    const existing = {
      targetRoles: 'Engineer',
      aiSettings: { keys: { openai: '••••1234' } },
      futureFlag: { enabled: true },
      notificationPreferences: { ...DEFAULT_NOTIFICATION_PREFERENCES },
    }

    expect(mergeUserPreferences(existing, {
      targetLocations: 'Berlin',
      notificationPreferences: { weekly: true },
    })).toEqual({
      ...existing,
      targetLocations: 'Berlin',
      notificationPreferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, weekly: true },
    })
  })

  it('preserves existing boolean choices when a toggle sends a partial patch', () => {
    const existing = {
      notificationPreferences: {
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        reject: false,
        followUp: false,
      },
      privacyPreferences: {
        ...DEFAULT_PRIVACY_PREFERENCES,
        shareUsageData: false,
      },
    }

    expect(mergeUserPreferences(existing, {
      notificationPreferences: { weekly: true },
      privacyPreferences: { allowAiTraining: true },
    })).toMatchObject({
      notificationPreferences: { reject: false, followUp: false, weekly: true },
      privacyPreferences: { shareUsageData: false, allowAiTraining: true },
    })
  })

  it('accepts secure remote avatars and small image data URLs', () => {
    expect(validateAvatarValue('https://cdn.example/avatar.png')).toEqual({ valid: true })
    expect(validateAvatarValue('data:image/png;base64,AAAA')).toEqual({ valid: true })
  })

  it('rejects unsafe or oversized avatar values', () => {
    expect(validateAvatarValue('javascript:alert(1)')).toMatchObject({ valid: false })
    expect(validateAvatarValue('data:text/plain;base64,AAAA')).toMatchObject({ valid: false })
    expect(validateAvatarValue(`data:image/png;base64,${'A'.repeat(2_800_000)}`)).toMatchObject({ valid: false })
  })
})
