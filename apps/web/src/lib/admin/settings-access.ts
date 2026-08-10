import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  DEFAULT_PRIVACY_PREFERENCES,
  readNotificationPreferences,
  readPrivacyPreferences,
  type SettingsPreferences,
} from '@/lib/settings-preferences'
import type { NotificationPreferences, PrivacyPreferences, UserPreferences } from '@/lib/types'
import { isPrivacyPreferenceAvailable } from '@/lib/privacy-consent'
import { userIntegrationStatus } from './integration-status'

type StoredUser = Record<string, unknown>

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

type DeletionRequestStatus = NonNullable<UserPreferences['dataDeletionRequestStatus']>

const DELETION_STATUSES = new Set<DeletionRequestStatus>([
  'requested', 'processing', 'completed', 'cancelled',
])

export type AdminSettingsPatch = {
  notificationPreferences?: Partial<NotificationPreferences>
  privacyPreferences?: Partial<PrivacyPreferences>
  dataDeletionRequestStatus?: DeletionRequestStatus
}

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@')
  if (!domain) return '***'
  return `${local.slice(0, 1)}***@${domain}`
}

function maskName(name: unknown): string | null {
  if (typeof name !== 'string' || !name.trim()) return null
  const trimmed = name.trim()
  return `${trimmed.slice(0, 1)}***`
}

function maskPhone(phone: unknown): string | null {
  if (typeof phone !== 'string' || !phone.trim()) return null
  const digits = phone.replace(/\D/g, '')
  return digits.length >= 2 ? `***${digits.slice(-2)}` : '***'
}

function maskLocation(location: unknown): string | null {
  if (typeof location !== 'string' || !location.trim()) return null
  return `${location.trim().slice(0, 1)}***`
}

function boundedString(value: unknown, max = 240): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function isoDate(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  return typeof value === 'string' ? value : null
}

export function canTransitionDeletionRequest(
  preferences: unknown,
  nextStatus: DeletionRequestStatus,
): boolean {
  const current = asRecord(preferences)
  if (typeof current.dataDeletionRequestedAt !== 'string') return false

  if (current.dataDeletionRequestStatus === 'requested') {
    return nextStatus === 'processing' || nextStatus === 'cancelled'
  }
  if (current.dataDeletionRequestStatus === 'processing') {
    return nextStatus === 'completed' || nextStatus === 'cancelled'
  }
  return false
}

/** Explicit DTO: never spread a Prisma User object into an admin response. */
export function toAdminSettingsDto(input: StoredUser) {
  const preferences = input.preferences && typeof input.preferences === 'object' && !Array.isArray(input.preferences)
    ? input.preferences as Record<string, unknown>
    : {}
  const safePreferences: SettingsPreferences = {
    targetRoles: boundedString(preferences.targetRoles),
    targetLocations: boundedString(preferences.targetLocations),
    salaryExpectation: boundedString(preferences.salaryExpectation),
    workAuthorization: boundedString(preferences.workAuthorization),
    openToRelocation: typeof preferences.openToRelocation === 'boolean' ? preferences.openToRelocation : true,
    notificationPreferences: readNotificationPreferences(preferences),
    privacyPreferences: readPrivacyPreferences(preferences),
  }
  if (typeof preferences.dataDeletionRequestedAt === 'string') {
    safePreferences.dataDeletionRequestedAt = preferences.dataDeletionRequestedAt
  }
  const deletionStatus = preferences.dataDeletionRequestStatus
  if (typeof deletionStatus === 'string' && DELETION_STATUSES.has(deletionStatus as DeletionRequestStatus)) {
    safePreferences.dataDeletionRequestStatus = deletionStatus as DeletionRequestStatus
  }

  const accounts = Array.isArray(input.accounts)
    ? input.accounts.map(account => {
        const parsed = asRecord(account)
        return { provider: parsed.provider, scope: parsed.scope }
      })
    : []
  const apiKeys = asRecord(input.apiKeys)

  return {
    id: boundedString(input.id, 100),
    email: maskEmail(boundedString(input.email, 320)),
    name: maskName(input.name),
    plan: boundedString(input.plan, 24),
    profile: {
      phone: maskPhone(input.phone),
      location: maskLocation(input.location),
      hasLinkedin: Boolean(boundedString(input.linkedin)),
      hasGithub: Boolean(boundedString(input.github)),
    },
    preferences: safePreferences,
    account: {
      createdAt: isoDate(input.createdAt),
      onboarded: input.onboardedAt != null,
    },
    integrations: userIntegrationStatus({
      preferences,
      apiKeys: {
        adzunaAppId: typeof apiKeys.adzunaAppId === 'string' ? apiKeys.adzunaAppId : null,
        adzunaAppIdEnc: typeof apiKeys.adzunaAppIdEnc === 'string' ? apiKeys.adzunaAppIdEnc : null,
        adzunaAppKey: typeof apiKeys.adzunaAppKey === 'string' ? apiKeys.adzunaAppKey : null,
        adzunaAppKeyEnc: typeof apiKeys.adzunaAppKeyEnc === 'string' ? apiKeys.adzunaAppKeyEnc : null,
        rapidapiKey: typeof apiKeys.rapidapiKey === 'string' ? apiKeys.rapidapiKey : null,
        rapidapiKeyEnc: typeof apiKeys.rapidapiKeyEnc === 'string' ? apiKeys.rapidapiKeyEnc : null,
      },
      accounts,
    }),
  }
}

const NOTIFICATION_KEYS = new Set(Object.keys(DEFAULT_NOTIFICATION_PREFERENCES))
const PRIVACY_KEYS = new Set(Object.keys(DEFAULT_PRIVACY_PREFERENCES))

function parseBooleanMap(value: unknown, allowed: Set<string>): Record<string, boolean> | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'Preference groups must be objects' }
  const result: Record<string, boolean> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!allowed.has(key)) return { error: `Unsupported settings field: ${key}` }
    if (typeof raw !== 'boolean') return { error: `${key} must be boolean` }
    result[key] = raw
  }
  return result
}

export function parseAdminSettingsPatch(value: unknown): AdminSettingsPatch | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'Invalid settings body' }
  const body = value as Record<string, unknown>
  const keys = Object.keys(body)
  const allowed = new Set(['notificationPreferences', 'privacyPreferences', 'dataDeletionRequestStatus'])
  if (keys.some(key => !allowed.has(key))) {
    return { error: 'Only notification, privacy, and deletion-request fields can be changed here' }
  }

  const patch: AdminSettingsPatch = {}
  if (body.notificationPreferences !== undefined) {
    const parsed = parseBooleanMap(body.notificationPreferences, NOTIFICATION_KEYS)
    if ('error' in parsed) return parsed
    patch.notificationPreferences = parsed
  }
  if (body.privacyPreferences !== undefined) {
    const parsed = parseBooleanMap(body.privacyPreferences, PRIVACY_KEYS)
    if ('error' in parsed) return parsed
    const unavailable = Object.keys(parsed).find(key => !isPrivacyPreferenceAvailable(key as keyof PrivacyPreferences))
    if (unavailable) return { error: `${unavailable} is currently unavailable` }
    patch.privacyPreferences = parsed
  }
  if (body.dataDeletionRequestStatus !== undefined) {
    if (typeof body.dataDeletionRequestStatus !== 'string' || !DELETION_STATUSES.has(body.dataDeletionRequestStatus as DeletionRequestStatus)) {
      return { error: 'Unsupported deletion request status' }
    }
    patch.dataDeletionRequestStatus = body.dataDeletionRequestStatus as DeletionRequestStatus
  }
  if (!patch.notificationPreferences && !patch.privacyPreferences && !patch.dataDeletionRequestStatus) {
    return { error: 'No settings fields provided' }
  }
  return patch
}

export function readAdminSettings(preferences: unknown): SettingsPreferences {
  const input = preferences && typeof preferences === 'object' && !Array.isArray(preferences)
    ? preferences as Record<string, unknown>
    : {}
  return {
    targetRoles: boundedString(input.targetRoles),
    targetLocations: boundedString(input.targetLocations),
    salaryExpectation: boundedString(input.salaryExpectation),
    workAuthorization: boundedString(input.workAuthorization),
    openToRelocation: typeof input.openToRelocation === 'boolean' ? input.openToRelocation : true,
    notificationPreferences: readNotificationPreferences(input),
    privacyPreferences: readPrivacyPreferences(input),
  }
}

/** Values retained in an append-only admin audit record. No PII or credentials. */
export function adminSettingsAuditSnapshot(preferences: unknown) {
  const safe = readAdminSettings(preferences)
  const current = asRecord(preferences)
  const snapshot: {
    notificationPreferences: NotificationPreferences
    privacyPreferences: PrivacyPreferences
    dataDeletionRequestStatus?: DeletionRequestStatus
  } = {
    notificationPreferences: safe.notificationPreferences,
    privacyPreferences: safe.privacyPreferences,
  }
  const status = current.dataDeletionRequestStatus
  if (typeof status === 'string' && DELETION_STATUSES.has(status as DeletionRequestStatus)) {
    snapshot.dataDeletionRequestStatus = status as DeletionRequestStatus
  }
  return snapshot
}
