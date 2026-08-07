import { describe, expect, it } from 'vitest'
import {
  allowsAiTraining,
  allowsUsageAnalytics,
  isPrivacyPreferenceAvailable,
  PRIVACY_CAPABILITIES,
  retainsGeneratedCoverLetters,
} from './privacy-consent'

describe('privacy consent', () => {
  it('uses the shared preference defaults and gates unavailable training', () => {
    expect(allowsUsageAnalytics({ privacyPreferences: { shareUsageData: false } })).toBe(false)
    expect(retainsGeneratedCoverLetters({ privacyPreferences: { storeCoverLetters: false } })).toBe(false)
    expect(allowsAiTraining({ privacyPreferences: { allowAiTraining: true } })).toBe(false)
    expect(PRIVACY_CAPABILITIES.aiTraining).toBe(false)
    expect(isPrivacyPreferenceAvailable('allowAiTraining')).toBe(false)
    expect(isPrivacyPreferenceAvailable('shareUsageData')).toBe(true)
    expect(isPrivacyPreferenceAvailable('storeCoverLetters')).toBe(true)
  })
})
