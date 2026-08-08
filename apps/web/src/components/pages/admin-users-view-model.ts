import type { NotificationPreferences, PrivacyPreferences } from '@/lib/types'
import type { SettingsPreferences } from '@/lib/settings-preferences'
import type { UserIntegrationStatus } from '@/lib/admin/integration-status'

export interface AdminSettingsUser {
  id: string
  email: string
  name: string | null
  plan: string
  profile: {
    phone: string | null
    location: string | null
    hasLinkedin: boolean
    hasGithub: boolean
  }
  preferences: SettingsPreferences
  account?: { createdAt: string | null; onboarded: boolean }
  integrations?: UserIntegrationStatus
}

export type AdminSettingsPatch = {
  notificationPreferences: NotificationPreferences
  privacyPreferences: PrivacyPreferences
  reason: string
  dataDeletionRequestStatus?: NonNullable<SettingsPreferences['dataDeletionRequestStatus']>
}

export type DeletionRequestAction = {
  status: NonNullable<SettingsPreferences['dataDeletionRequestStatus']>
  label: string
}

export function filterAdminUsers(users: AdminSettingsUser[], query: string): AdminSettingsUser[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return users
  return users.filter(user => [
    user.id,
    user.email,
    user.name,
    user.profile.location,
    user.preferences.targetRoles,
    user.preferences.targetLocations,
  ]
    .some(value => value?.toLowerCase().includes(normalized)))
}

export function buildAdminSettingsPatch(
  notificationPreferences: NotificationPreferences,
  privacyPreferences: PrivacyPreferences,
  reason: string,
  dataDeletionRequestStatus?: NonNullable<SettingsPreferences['dataDeletionRequestStatus']>,
): AdminSettingsPatch {
  const auditReason = reason.trim()
  if (auditReason.length < 10 || auditReason.length > 500) {
    throw new Error('Enter a settings-change reason between 10 and 500 characters.')
  }

  return {
    notificationPreferences: { ...notificationPreferences },
    privacyPreferences: { ...privacyPreferences },
    reason: auditReason,
    ...(dataDeletionRequestStatus ? { dataDeletionRequestStatus } : {}),
  }
}

export function getDeletionRequestLabel(user: AdminSettingsUser): string {
  const status = user.preferences.dataDeletionRequestStatus
  const requestedAt = user.preferences.dataDeletionRequestedAt
  if (!status || !requestedAt) return 'No deletion request'
  const date = requestedAt.slice(0, 10)
  if (status === 'processing') return `Deletion request processing (since ${date})`
  if (status === 'completed') return `Deletion completed on ${date}`
  if (status === 'cancelled') return `Deletion request cancelled on ${date}`
  return `Deletion requested on ${date}`
}

export function getDeletionRequestActions(user: AdminSettingsUser): DeletionRequestAction[] {
  if (!user.preferences.dataDeletionRequestedAt) return []
  if (user.preferences.dataDeletionRequestStatus === 'requested') {
    return [
      { status: 'processing', label: 'Start processing' },
      { status: 'cancelled', label: 'Cancel request' },
    ]
  }
  if (user.preferences.dataDeletionRequestStatus === 'processing') {
    return [
      { status: 'completed', label: 'Record completion' },
      { status: 'cancelled', label: 'Cancel request' },
    ]
  }
  return []
}
