export interface AdminRoleDto {
  id: string
  key: string
  name: string
  permissions: string[]
  system: boolean
  version: number
}

export interface AdminMemberDto {
  id: string
  userId: string
  status: string
  mfaLevel: string
  sessionVersion: number
  grantedAt: string
  role: {
    key: string
    name: string
    permissions: string[]
  }
  user: {
    id: string
    email: string
    name: string
    plan: string
  }
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

export function maskEmail(value: string | null | undefined): string {
  const email = value?.trim() ?? ''
  const at = email.indexOf('@')
  if (at <= 0) return email ? '***' : ''
  return `${email.slice(0, 1)}***${email.slice(at)}`
}

export function maskName(value: string | null | undefined): string {
  return (value?.trim() ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map(part => `${part.slice(0, 1)}***`)
    .join(' ')
}

export function toAdminRoleDto(input: unknown): AdminRoleDto {
  const row = record(input)
  const permissions = Array.isArray(row.permissions)
    ? row.permissions.filter((permission): permission is string => typeof permission === 'string')
    : []
  return {
    id: stringValue(row.id),
    key: stringValue(row.key),
    name: stringValue(row.name),
    permissions,
    system: row.system === true,
    version: numberValue(row.version),
  }
}

export function toAdminMemberDto(input: unknown): AdminMemberDto {
  const row = record(input)
  const user = record(row.user)
  return {
    id: stringValue(row.id),
    userId: stringValue(row.userId),
    status: stringValue(row.status),
    mfaLevel: stringValue(row.mfaLevel),
    sessionVersion: numberValue(row.sessionVersion),
    grantedAt: dateValue(row.grantedAt),
    role: (() => {
      const role = toAdminRoleDto(row.role)
      return { key: role.key, name: role.name, permissions: role.permissions }
    })(),
    user: {
      id: stringValue(user.id),
      email: maskEmail(stringValue(user.email)),
      name: maskName(stringValue(user.name)),
      plan: stringValue(user.plan),
    },
  }
}

export function toAdminUserDto(input: unknown): AdminUserDto {
  const row = record(input)
  const count = record(row._count)
  return {
    id: stringValue(row.id),
    email: maskEmail(stringValue(row.email)),
    name: maskName(stringValue(row.name)),
    plan: stringValue(row.plan),
    accountStatus: stringValue(row.accountStatus),
    region: maskRegion(stringValue(row.location)),
    createdAt: dateValue(row.createdAt),
    updatedAt: dateValue(row.updatedAt),
    suspendedAt: dateValue(row.suspendedAt) || null,
    counts: {
      resumes: numberValue(count.resumes),
      jobs: numberValue(count.jobs),
      applicationTasks: numberValue(count.applicationTasks),
    },
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function dateValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  return typeof value === 'string' ? value : ''
}

function maskRegion(value: string): string {
  const parts = value.split(',').map(part => part.trim()).filter(Boolean)
  return parts.length > 1 ? parts[parts.length - 1] : ''
}
