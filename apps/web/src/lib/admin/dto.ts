type UserMetadataRecord = {
  id: string
  name: string | null
  email: string
  plan: string
  location: string | null
  createdAt: Date
  _count?: { jobs: number; resumes: number; notifications: number }
  gmailSyncState?: { lastSyncedAt: Date | null; lastError: string | null } | null
}

function maskEmail(email: string) {
  const [local, domain = ''] = email.split('@')
  const localMask = local.length < 3 ? `${local[0] ?? ''}*` : `${local.slice(0, 2)}***`
  return `${localMask}@${domain}`
}

function maskLocation(location: string | null) {
  if (!location) return null
  return `${location.slice(0, 1)}***`
}

function maskName(name: string | null) {
  if (!name) return null
  return name.split(/\s+/).filter(Boolean).map((part) => `${part.slice(0, 1)}***`).join(' ')
}

export function toAdminUserMetadata(user: UserMetadataRecord) {
  return {
    id: user.id,
    name: maskName(user.name),
    email: maskEmail(user.email),
    plan: user.plan,
    location: maskLocation(user.location),
    createdAt: user.createdAt,
    jobsCount: user._count?.jobs ?? 0,
    resumeExists: (user._count?.resumes ?? 0) > 0,
    notificationsCount: user._count?.notifications ?? 0,
    gmail: user.gmailSyncState ? { connected: true, lastSyncedAt: user.gmailSyncState.lastSyncedAt, hasError: Boolean(user.gmailSyncState.lastError) } : { connected: false, lastSyncedAt: null, hasError: false },
  }
}

export const adminUserMetadataSelect = {
  id: true,
  name: true,
  email: true,
  plan: true,
  location: true,
  createdAt: true,
  _count: { select: { jobs: true, resumes: true, notifications: true } },
  gmailSyncState: { select: { lastSyncedAt: true, lastError: true } },
} as const

export interface AdminRoleDto {
  id: string
  key: string
  name: string
  permissions: string[]
  system: boolean
  version: number
}

export interface AdminUserDto {
  id: string
  email: string
  name: string
  plan: string
  accountStatus: string
  region: string
  createdAt: string
  updatedAt: string
  suspendedAt: string | null
  counts: { resumes: number; jobs: number; applicationTasks: number }
}

export function toAdminRoleDto(input: unknown): AdminRoleDto {
  const row = record(input)
  return {
    id: stringValue(row.id),
    key: stringValue(row.key),
    name: stringValue(row.name),
    permissions: Array.isArray(row.permissions) ? row.permissions.filter((value): value is string => typeof value === 'string') : [],
    system: row.system === true,
    version: numberValue(row.version, 1),
  }
}

export function toAdminUserDto(input: unknown): AdminUserDto {
  const row = record(input)
  const count = record(row._count)
  return {
    id: stringValue(row.id),
    email: maskEmail(stringValue(row.email)),
    name: maskName(stringValue(row.name)) ?? '',
    plan: stringValue(row.plan),
    accountStatus: stringValue(row.accountStatus),
    region: maskRegion(stringValue(row.location)),
    createdAt: dateValue(row.createdAt),
    updatedAt: dateValue(row.updatedAt),
    suspendedAt: dateValue(row.suspendedAt) || null,
    counts: { resumes: numberValue(count.resumes, 0), jobs: numberValue(count.jobs, 0), applicationTasks: numberValue(count.applicationTasks, 0) },
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown): string { return typeof value === 'string' ? value : '' }
function numberValue(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback }
function dateValue(value: unknown): string { return value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : '' }
function maskRegion(value: string): string {
  const parts = value.split(',').map(part => part.trim()).filter(Boolean)
  return parts.length > 1 ? parts[parts.length - 1] : ''
}
