import { describe, expect, it } from 'vitest'

import {
  buildAdminSettingsPatch,
  filterAdminUsers,
  getDeletionRequestActions,
  getDeletionRequestLabel,
  type AdminSettingsUser,
} from './admin-users-view-model'

const users: AdminSettingsUser[] = [
  {
    id: 'u1', email: 'a***@example.com', name: 'A***', plan: 'pro',
    profile: { phone: null, location: 'Berlin', hasLinkedin: false, hasGithub: true },
    preferences: {
      targetRoles: 'Engineer', targetLocations: 'Berlin', salaryExpectation: '',
      workAuthorization: 'EU', openToRelocation: true,
      notificationPreferences: { apply: true, reject: true, interview: true, offer: true, weekly: false, followUp: true },
      privacyPreferences: { shareUsageData: true, allowAiTraining: false, storeCoverLetters: true },
    },
  },
  {
    id: 'u2', email: 'b***@example.com', name: null, plan: 'free',
    profile: { phone: null, location: null, hasLinkedin: false, hasGithub: false },
    preferences: {
      targetRoles: 'Designer', targetLocations: 'Paris', salaryExpectation: '',
      workAuthorization: 'EU', openToRelocation: true,
      notificationPreferences: { apply: true, reject: true, interview: true, offer: true, weekly: false, followUp: true },
      privacyPreferences: { shareUsageData: true, allowAiTraining: false, storeCoverLetters: true },
      dataDeletionRequestStatus: 'requested',
      dataDeletionRequestedAt: '2026-08-05T10:00:00.000Z',
    },
  },
]

describe('admin users view model', () => {
  it('filters by masked email, name, location, or id', () => {
    expect(filterAdminUsers(users, 'paris')).toEqual([users[1]])
    expect(filterAdminUsers(users, 'u1')).toEqual([users[0]])
    expect(filterAdminUsers(users, '')).toEqual(users)
  })

  it('builds a bounded settings patch from the two editable groups', () => {
    const patch = buildAdminSettingsPatch(users[0].preferences.notificationPreferences, users[0].preferences.privacyPreferences)
    expect(patch).toEqual({
      notificationPreferences: users[0].preferences.notificationPreferences,
      privacyPreferences: users[0].preferences.privacyPreferences,
    })
    expect(JSON.stringify(patch)).not.toContain('targetRoles')
  })

  it('describes deletion request state without exposing empty timestamps', () => {
    expect(getDeletionRequestLabel(users[1])).toBe('Deletion requested on 2026-08-05')
    expect(getDeletionRequestLabel(users[0])).toBe('No deletion request')
  })

  it('does not include read-only operational fields in the settings patch', () => {
    const patch = buildAdminSettingsPatch(
      users[0].preferences.notificationPreferences,
      users[0].preferences.privacyPreferences,
    )
    expect(patch).toEqual({
      notificationPreferences: users[0].preferences.notificationPreferences,
      privacyPreferences: users[0].preferences.privacyPreferences,
    })
    expect(JSON.stringify(patch)).not.toContain('plan')
    expect(JSON.stringify(patch)).not.toContain('targetLocations')
  })

  it('offers only the allowed administrative actions for an active deletion request', () => {
    expect(getDeletionRequestActions(users[1])).toEqual([
      { status: 'processing', label: 'Start processing' },
      { status: 'cancelled', label: 'Cancel request' },
    ])
    expect(getDeletionRequestActions(users[0])).toEqual([])
  })
})
