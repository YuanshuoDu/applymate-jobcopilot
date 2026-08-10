import { describe, expect, it, vi } from 'vitest'

vi.mock('./integration-status', () => ({
  userIntegrationStatus: () => ({
    accounts: { gmail: false, github: false },
    ai: { providers: {}, featureOverrides: 0, customConfigured: false },
    discovery: { hasAdzuna: false, hasRapidapi: false, adzunaSource: null, rapidapiSource: null },
  }),
}))

import {
  adminSettingsAuditSnapshot,
  canTransitionDeletionRequest,
  parseAdminSettingsPatch,
  toAdminSettingsDto,
} from './settings-access'
import { mergeUserPreferences } from '@/lib/settings-preferences'

describe('admin settings access', () => {
  it('returns only masked settings metadata and never serializes secret fields', () => {
    const dto = toAdminSettingsDto({
      id: 'user_1', email: 'candidate@example.com', name: 'Candidate Name', plan: 'pro',
      phone: '+353123456', location: 'Dublin', linkedin: 'linkedin.com/in/candidate', github: 'github.com/candidate',
      preferences: {
        targetRoles: 'Engineer', targetLocations: 'Dublin', salaryExpectation: '€70k',
        workAuthorization: 'EU', openToRelocation: true,
        notificationPreferences: { apply: false }, privacyPreferences: { allowAiTraining: true },
        dataDeletionRequestedAt: '2026-08-05T10:00:00.000Z',
        dataDeletionRequestStatus: 'requested',
        aiSettings: { keys: { openai: 'do-not-return' } },
      },
      password: 'hash', personaFields: [{ value: 'private' }],
    })

    expect(dto).toMatchObject({
      id: 'user_1',
      plan: 'pro',
      preferences: {
        targetRoles: 'Engineer',
        notificationPreferences: { apply: false, reject: true },
        dataDeletionRequestedAt: '2026-08-05T10:00:00.000Z',
        dataDeletionRequestStatus: 'requested',
      },
    })
    expect(JSON.stringify(dto)).not.toContain('do-not-return')
    expect(JSON.stringify(dto)).not.toContain('password')
    expect(JSON.stringify(dto)).not.toContain('private')
    expect(dto.email).not.toBe('candidate@example.com')
    expect(dto.profile.location).toBe('D***')
    expect(JSON.stringify(dto)).not.toContain('"location":"Dublin"')
  })

  it('accepts only bounded notification, privacy, and deletion-status patch fields', () => {
    expect(parseAdminSettingsPatch({ notificationPreferences: { weekly: true } })).toEqual({
      notificationPreferences: { weekly: true },
    })
    expect(parseAdminSettingsPatch({ dataDeletionRequestStatus: 'processing' })).toEqual({
      dataDeletionRequestStatus: 'processing',
    })
    expect(parseAdminSettingsPatch({ aiSettings: { keys: { openai: 'secret' } } })).toMatchObject({ error: expect.any(String) })
    expect(parseAdminSettingsPatch({ privacyPreferences: { allowAiTraining: 'yes' } })).toMatchObject({ error: expect.any(String) })
  })

  it('rejects unavailable privacy controls while retaining editable privacy changes', () => {
    expect(parseAdminSettingsPatch({ privacyPreferences: { allowAiTraining: true } })).toEqual({
      error: 'allowAiTraining is currently unavailable',
    })
    expect(parseAdminSettingsPatch({ privacyPreferences: { shareUsageData: false, storeCoverLetters: false } })).toEqual({
      privacyPreferences: { shareUsageData: false, storeCoverLetters: false },
    })
  })

  it('preserves an unavailable stored value while applying editable privacy changes', () => {
    const patch = parseAdminSettingsPatch({ privacyPreferences: { shareUsageData: false, storeCoverLetters: false } })
    expect('error' in patch).toBe(false)
    if ('error' in patch) return

    expect(mergeUserPreferences({
      privacyPreferences: { shareUsageData: true, allowAiTraining: true, storeCoverLetters: true },
    }, patch)).toMatchObject({
      privacyPreferences: { shareUsageData: false, allowAiTraining: true, storeCoverLetters: false },
    })
  })

  it('serializes Prisma Date values in the admin account metadata', () => {
    const dto = toAdminSettingsDto({
      id: 'user_1', email: 'candidate@example.com', name: null, plan: 'free',
      preferences: {}, createdAt: new Date('2026-08-01T12:00:00.000Z'), onboardedAt: null,
    })

    expect(dto.account.createdAt).toBe('2026-08-01T12:00:00.000Z')
  })

  it('permits only valid deletion-request state transitions', () => {
    const requested = {
      dataDeletionRequestedAt: '2026-08-05T10:00:00.000Z',
      dataDeletionRequestStatus: 'requested',
    }
    const processing = { ...requested, dataDeletionRequestStatus: 'processing' }

    expect(canTransitionDeletionRequest(requested, 'processing')).toBe(true)
    expect(canTransitionDeletionRequest(requested, 'cancelled')).toBe(true)
    expect(canTransitionDeletionRequest(requested, 'completed')).toBe(false)
    expect(canTransitionDeletionRequest(processing, 'completed')).toBe(true)
    expect(canTransitionDeletionRequest({}, 'processing')).toBe(false)
  })

  it('rejects operational fields outside the bounded workflows', () => {
    expect(parseAdminSettingsPatch({ plan: 'pro' })).toMatchObject({ error: expect.any(String) })
    expect(parseAdminSettingsPatch({ dataDeletionRequestStatus: 'purged' })).toMatchObject({ error: expect.any(String) })
    expect(parseAdminSettingsPatch({ jobPreferences: { targetLocations: 'Berlin' } })).toMatchObject({ error: expect.any(String) })
    expect(parseAdminSettingsPatch({ aiSettings: { keys: { openai: 'secret' } } })).toMatchObject({ error: expect.any(String) })
  })

  it('creates an audit snapshot containing only editable preference state', () => {
    const snapshot = adminSettingsAuditSnapshot({
      notificationPreferences: { apply: false },
      privacyPreferences: { shareUsageData: false },
      dataDeletionRequestStatus: 'processing',
      aiSettings: { keys: { openai: 'secret' } },
    })

    expect(snapshot).toEqual({
      notificationPreferences: { apply: false, reject: true, interview: true, offer: true, weekly: false, followUp: true },
      privacyPreferences: { shareUsageData: false, allowAiTraining: false, storeCoverLetters: true },
      dataDeletionRequestStatus: 'processing',
    })
    expect(JSON.stringify(snapshot)).not.toContain('secret')
  })
})
