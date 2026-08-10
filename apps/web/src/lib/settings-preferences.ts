import type { NotificationPreferences, PrivacyPreferences, UserPreferences } from './types'
import { isEncryptedSecret } from '@jobcopilot/shared'

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  apply: true,
  reject: true,
  interview: true,
  offer: true,
  weekly: false,
  followUp: true,
}

export const DEFAULT_PRIVACY_PREFERENCES: PrivacyPreferences = {
  shareUsageData: true,
  allowAiTraining: false,
  storeCoverLetters: true,
}

type PreferenceRecord = Record<string, unknown>

type ValidationResult = { valid: true } | { valid: false; error: string }

function asRecord(value: unknown): PreferenceRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as PreferenceRecord
    : {}
}

const PROFILE_STRING_FIELDS = ['name', 'phone', 'location', 'linkedin', 'github'] as const
const JOB_PREFERENCE_STRING_FIELDS = ['targetRoles', 'targetLocations', 'salaryExpectation', 'workAuthorization'] as const
const PROFILE_PREFERENCE_FIELDS = new Set<string>([
  ...JOB_PREFERENCE_STRING_FIELDS,
  'openToRelocation',
  'notificationPreferences',
  'privacyPreferences',
])

function validateBooleanGroup(value: unknown, label: string): ValidationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, error: `${label} must be an object` }
  }
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'boolean') return { valid: false, error: `${label}.${key} must be boolean` }
  }
  return { valid: true }
}

export function validateUserProfilePatch(value: unknown): ValidationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, error: 'Profile update must be an object' }
  }
  const body = value as PreferenceRecord
  for (const field of PROFILE_STRING_FIELDS) {
    if (body[field] !== undefined && body[field] !== null && typeof body[field] !== 'string') {
      return { valid: false, error: `${field} must be a string` }
    }
  }

  if (body.preferences !== undefined) {
    if (!body.preferences || typeof body.preferences !== 'object' || Array.isArray(body.preferences)) {
      return { valid: false, error: 'preferences must be an object' }
    }
    const preferences = body.preferences as PreferenceRecord
    const unsupportedField = Object.keys(preferences).find(field => !PROFILE_PREFERENCE_FIELDS.has(field))
    if (unsupportedField) return { valid: false, error: `Unsupported preference field ${unsupportedField}` }
    for (const field of JOB_PREFERENCE_STRING_FIELDS) {
      if (preferences[field] !== undefined && typeof preferences[field] !== 'string') {
        return { valid: false, error: `preferences.${field} must be a string` }
      }
    }
    if (preferences.openToRelocation !== undefined && typeof preferences.openToRelocation !== 'boolean') {
      return { valid: false, error: 'preferences.openToRelocation must be boolean' }
    }
    for (const [key, label] of [
      ['notificationPreferences', 'notificationPreferences'],
      ['privacyPreferences', 'privacyPreferences'],
    ] as const) {
      if (preferences[key] !== undefined) {
        const result = validateBooleanGroup(preferences[key], label)
        if (!result.valid) return result
      }
    }
  }
  return { valid: true }
}

function readBooleanPreference<T extends object>(
  value: unknown,
  defaults: T,
): T {
  const input = asRecord(value)
  const result = { ...defaults }
  for (const key of Object.keys(defaults)) {
    if (typeof input[key] === 'boolean') (result as Record<string, unknown>)[key] = input[key]
  }
  return result
}

function mergeBooleanPreference<T extends object>(
  current: unknown,
  patch: unknown,
  defaults: T,
): T {
  const result = readBooleanPreference(current, defaults)
  const input = asRecord(patch)
  for (const key of Object.keys(defaults)) {
    if (typeof input[key] === 'boolean') (result as Record<string, unknown>)[key] = input[key]
  }
  return result
}

export function readNotificationPreferences(value: unknown): NotificationPreferences {
  return readBooleanPreference(asRecord(value).notificationPreferences, DEFAULT_NOTIFICATION_PREFERENCES)
}

export function readPrivacyPreferences(value: unknown): PrivacyPreferences {
  return readBooleanPreference(asRecord(value).privacyPreferences, DEFAULT_PRIVACY_PREFERENCES)
}

export function hasActiveDeletionRequest(value: unknown): boolean {
  const current = asRecord(value)
  return typeof current.dataDeletionRequestedAt === 'string'
    && (current.dataDeletionRequestStatus === 'requested' || current.dataDeletionRequestStatus === 'processing')
}

function maskSecret(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  if (isEncryptedSecret(value)) return '••••'
  return value.length <= 8 ? '••••' : `••••${value.slice(-4)}`
}

/** Remove raw provider credentials before preferences are returned in a profile DTO. */
export function sanitizeUserPreferences(value: unknown): PreferenceRecord {
  const current = asRecord(value)
  const safe: PreferenceRecord = { ...current }
  const ai = asRecord(current.aiSettings)
  const keys = asRecord(ai.keys)
  const features = asRecord(ai.features)

  if (Object.keys(ai).length > 0) {
    const safeKeys: Record<string, string> = {}
    for (const [provider, key] of Object.entries(keys)) {
      const masked = maskSecret(key)
      if (masked) safeKeys[provider] = masked
    }

    const safeFeatures: Record<string, unknown> = {}
    for (const [feature, config] of Object.entries(features)) {
      if (config === null) {
        safeFeatures[feature] = null
        continue
      }
      const cfg = asRecord(config)
      const safeConfig: Record<string, unknown> = {}
      for (const field of ['provider', 'model', 'apiBase', 'thinking'] as const) {
        if (typeof cfg[field] === 'string') safeConfig[field] = cfg[field]
      }
      const masked = maskSecret(cfg.apiKey)
      if (masked) safeConfig.apiKey = masked
      safeFeatures[feature] = safeConfig
    }

    safe.aiSettings = { keys: safeKeys, features: safeFeatures }
  }

  return safe
}

/** Merge user preferences while retaining provider settings and unknown future keys. */
export function mergeUserPreferences(existing: unknown, patch: unknown): PreferenceRecord {
  const current = asRecord(existing)
  const incoming = asRecord(patch)
  const merged: PreferenceRecord = { ...current, ...incoming }

  const notificationPatch = incoming.notificationPreferences
  if (notificationPatch !== undefined) {
    merged.notificationPreferences = mergeBooleanPreference(
      current.notificationPreferences,
      notificationPatch,
      DEFAULT_NOTIFICATION_PREFERENCES,
    )
  }

  const privacyPatch = incoming.privacyPreferences
  if (privacyPatch !== undefined) {
    merged.privacyPreferences = mergeBooleanPreference(
      current.privacyPreferences,
      privacyPatch,
      DEFAULT_PRIVACY_PREFERENCES,
    )
  }

  // AI settings are an object owned by the model-router API. Preserve nested
  // provider/feature entries when a profile update includes only one branch.
  if (current.aiSettings && incoming.aiSettings && typeof current.aiSettings === 'object' && typeof incoming.aiSettings === 'object') {
    const currentAi = asRecord(current.aiSettings)
    const incomingAi = asRecord(incoming.aiSettings)
    merged.aiSettings = {
      ...currentAi,
      ...incomingAi,
      ...(currentAi.keys && incomingAi.keys ? { keys: { ...asRecord(currentAi.keys), ...asRecord(incomingAi.keys) } } : {}),
      ...(currentAi.features && incomingAi.features ? { features: { ...asRecord(currentAi.features), ...asRecord(incomingAi.features) } } : {}),
    }
  }

  return merged
}

const AVATAR_DATA_URL = /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/i
const MAX_AVATAR_BYTES = 2 * 1024 * 1024

export function validateAvatarValue(value: unknown): { valid: true } | { valid: false; error: string } {
  if (value === null || value === '') return { valid: true }
  if (typeof value !== 'string') return { valid: false, error: 'Avatar must be an image URL' }
  if (/^https:\/\//i.test(value)) {
    return value.length <= 2_048
      ? { valid: true }
      : { valid: false, error: 'Avatar URL is too long' }
  }
  if (!AVATAR_DATA_URL.test(value)) return { valid: false, error: 'Avatar must be a PNG, JPEG, WebP, or GIF image' }
  const payload = value.slice(value.indexOf(',') + 1)
  const bytes = Math.floor(payload.length * 3 / 4) - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0)
  return bytes <= MAX_AVATAR_BYTES
    ? { valid: true }
    : { valid: false, error: 'Avatar must be 2 MiB or smaller' }
}

export type SettingsPreferences = Pick<UserPreferences, 'targetRoles' | 'targetLocations' | 'salaryExpectation' | 'workAuthorization' | 'openToRelocation'> & {
  notificationPreferences: NotificationPreferences
  privacyPreferences: PrivacyPreferences
  dataDeletionRequestedAt?: string
  dataDeletionRequestStatus?: UserPreferences['dataDeletionRequestStatus']
}
