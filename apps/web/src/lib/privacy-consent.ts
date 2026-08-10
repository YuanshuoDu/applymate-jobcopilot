import type { PrivacyPreferences } from './types'
import { readPrivacyPreferences } from './settings-preferences'

/**
 * Privacy controls are kept in User.preferences so the candidate API and the
 * admin view share one contract. AI training is deliberately reported as
 * unavailable until a reviewed training pipeline exists.
 */
export const PRIVACY_CAPABILITIES = {
  usageAnalytics: true,
  aiTraining: false,
  coverLetterRetention: true,
} as const

export function isPrivacyPreferenceAvailable(key: keyof PrivacyPreferences): boolean {
  return key !== 'allowAiTraining' || PRIVACY_CAPABILITIES.aiTraining
}

export function editablePrivacyPreferences(preferences: PrivacyPreferences): Partial<PrivacyPreferences> {
  const editable: Partial<PrivacyPreferences> = {}
  for (const key of Object.keys(preferences) as Array<keyof PrivacyPreferences>) {
    if (isPrivacyPreferenceAvailable(key)) editable[key] = preferences[key]
  }
  return editable
}

export function allowsUsageAnalytics(preferences: unknown): boolean {
  return readPrivacyPreferences(preferences).shareUsageData
}

export function hasUsageAnalyticsConsentChanged(
  previous: Pick<PrivacyPreferences, 'shareUsageData'>,
  next: Pick<PrivacyPreferences, 'shareUsageData'>,
): boolean {
  return previous.shareUsageData !== next.shareUsageData
}

export function retainsGeneratedCoverLetters(preferences: unknown): boolean {
  return readPrivacyPreferences(preferences).storeCoverLetters
}

export function allowsAiTraining(preferences: unknown): boolean {
  return PRIVACY_CAPABILITIES.aiTraining && readPrivacyPreferences(preferences).allowAiTraining
}
