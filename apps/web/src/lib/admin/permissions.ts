export const PERMISSIONS = [
  'users.read', 'users.read_pii_masked', 'users.suspend', 'users.restore', 'users.export_anonymized',
  'billing.read', 'billing.update', 'billing.refund_mark',
  'jobs.read_metadata', 'jobs.read_content_masked', 'applications.read', 'applications.retry', 'applications.cancel', 'applications.manual_review',
  'ats.read', 'ats.update', 'ats.pause', 'ats.resume', 'ats.test', 'ats.registry.manage',
  'feature_flags.read', 'feature_flags.update', 'feature_flags.approve',
  'ai_budget.read', 'ai_budget.update', 'ai_budget.reset',
  'queues.read', 'queues.retry', 'queues.pause', 'queues.resume',
  'broadcasts.create', 'broadcasts.update', 'broadcasts.preview', 'broadcasts.approve', 'broadcasts.publish', 'broadcasts.cancel',
  'support_cases.read', 'support_cases.assign', 'support_cases.reply', 'support_cases.note', 'support_cases.resolve', 'support_cases.escalate', 'support_sla.manage', 'support_macros.manage',
  'admin_members.read', 'admin_members.manage', 'admin_roles.manage', 'sessions.revoke', 'audit.read', 'break_glass.request', 'break_glass.approve',
  'observability.read', 'incidents.manage',
] as const

export type Permission = (typeof PERMISSIONS)[number]
export type AdminRoleKey = 'support' | 'operations' | 'analyst' | 'billing' | 'security_admin' | 'platform_admin' | 'super_admin'

const rolePermissions: Record<AdminRoleKey, readonly Permission[]> = {
  support: ['support_cases.read', 'support_cases.assign', 'support_cases.reply', 'support_cases.note', 'support_cases.resolve', 'users.read', 'users.read_pii_masked'],
  operations: ['ats.read', 'ats.update', 'ats.pause', 'ats.resume', 'ats.test', 'applications.read', 'applications.retry', 'applications.cancel', 'applications.manual_review', 'queues.read', 'queues.retry', 'queues.pause', 'queues.resume', 'observability.read', 'broadcasts.create', 'broadcasts.update', 'broadcasts.preview', 'support_cases.escalate'],
  analyst: ['observability.read', 'ai_budget.read', 'users.export_anonymized'],
  billing: ['billing.read', 'billing.update', 'billing.refund_mark'],
  security_admin: ['admin_members.read', 'admin_members.manage', 'admin_roles.manage', 'sessions.revoke', 'audit.read', 'break_glass.request', 'break_glass.approve'],
  platform_admin: ['ats.read', 'ats.update', 'ats.pause', 'ats.resume', 'ats.test', 'ats.registry.manage', 'feature_flags.read', 'feature_flags.update', 'feature_flags.approve', 'ai_budget.read', 'ai_budget.update', 'broadcasts.create', 'broadcasts.update', 'broadcasts.preview', 'broadcasts.approve', 'broadcasts.publish', 'broadcasts.cancel', 'queues.read', 'observability.read', 'incidents.manage'],
  super_admin: PERMISSIONS,
}

export const SYSTEM_ROLES = (Object.keys(rolePermissions) as AdminRoleKey[]).map((key) => ({
  key,
  name: key.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase()),
  permissions: rolePermissions[key],
}))

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value)
}

// Compatibility exports used by the access-management slice. The operational
// permission catalogue above remains the single source of truth.
export const ADMIN_PERMISSION_KEYS = PERMISSIONS

export interface RoleSeed {
  name: string
  description: string
  system: boolean
  permissions: readonly Permission[]
}

export const ROLE_SEEDS = Object.fromEntries(
  SYSTEM_ROLES.map(role => [role.key, {
    name: role.name,
    description: `${role.name} administrative role`,
    system: true,
    permissions: role.permissions,
  }]),
) as Record<AdminRoleKey, RoleSeed>

export function validatePermissionList(values: unknown): Permission[] {
  if (!Array.isArray(values)) throw new Error('Permissions must be an array')
  const result: Permission[] = []
  for (const value of values) {
    if (typeof value !== 'string') throw new Error('Permission keys must be strings')
    const key = value.trim()
    if (!key) continue
    if (!isPermission(key)) throw new Error(`Unknown admin permission: ${key}`)
    if (!result.includes(key)) result.push(key)
  }
  return result
}

export interface AdminRoleActor {
  roleKey: string
  permissions: readonly string[]
}

export interface RoleEditTarget {
  key: string
  isLastSuperAdmin: boolean
}

export function canEditRole(
  actor: AdminRoleActor,
  target: RoleEditTarget,
  nextPermissions: unknown,
): { ok: true; permissions: Permission[] } | { ok: false; error: string } {
  if (!actor.permissions.includes('admin_roles.manage')) return { ok: false, error: 'Missing admin_roles.manage permission' }
  let permissions: Permission[]
  try {
    permissions = validatePermissionList(nextPermissions)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Invalid permissions' }
  }
  const actorPermissions = new Set(actor.permissions)
  if (permissions.some(permission => !actorPermissions.has(permission))) return { ok: false, error: 'Cannot grant a permission you do not hold' }
  if (target.key === 'super_admin' && target.isLastSuperAdmin && !permissions.includes('admin_roles.manage')) {
    return { ok: false, error: 'The last super admin must retain admin management permissions' }
  }
  return { ok: true, permissions }
}
