export const ADMIN_PERMISSION_KEYS = [
  'admin_members.read',
  'admin_members.manage',
  'admin_roles.manage',
  'sessions.revoke',
  'audit.read',
  'users.read',
  'users.read_pii_masked',
  'users.suspend',
  'users.restore',
  'users.export_anonymized',
  'billing.read',
  'billing.update',
  'billing.refund_mark',
  'jobs.read_metadata',
  'applications.read',
  'applications.retry',
  'applications.cancel',
  'applications.manual_review',
  'ai_budget.read',
  'ai_budget.update',
  'ai_budget.reset',
  'broadcasts.create',
  'broadcasts.update',
  'broadcasts.preview',
  'broadcasts.approve',
  'broadcasts.publish',
  'broadcasts.cancel',
  'support_cases.read',
  'support_cases.assign',
  'support_cases.reply',
  'support_cases.note',
  'support_cases.resolve',
  'support_cases.escalate',
  'observability.read',
] as const

export type Permission = typeof ADMIN_PERMISSION_KEYS[number]

export interface RoleSeed {
  name: string
  description: string
  system: boolean
  permissions: readonly Permission[]
}

const SUPPORT_PERMISSIONS: readonly Permission[] = [
  'admin_members.read',
  'users.read',
  'users.read_pii_masked',
  'support_cases.read',
  'support_cases.assign',
  'support_cases.reply',
  'support_cases.note',
  'support_cases.resolve',
]

const BILLING_PERMISSIONS: readonly Permission[] = [
  'users.read',
  'users.read_pii_masked',
  'billing.read',
  'billing.update',
]

const OPERATIONS_PERMISSIONS: readonly Permission[] = [
  'admin_members.read',
  'users.read',
  'jobs.read_metadata',
  'applications.read',
  'applications.retry',
  'applications.cancel',
  'applications.manual_review',
  'ai_budget.read',
  'broadcasts.create',
  'broadcasts.update',
  'broadcasts.preview',
  'support_cases.read',
  'observability.read',
]

const SECURITY_PERMISSIONS: readonly Permission[] = [
  'admin_members.read',
  'admin_members.manage',
  'admin_roles.manage',
  'sessions.revoke',
  'audit.read',
]

const PLATFORM_PERMISSIONS: readonly Permission[] = [
  'admin_members.read',
  'users.read',
  'users.read_pii_masked',
  'users.suspend',
  'users.restore',
  'billing.read',
  'billing.update',
  'ai_budget.read',
  'ai_budget.update',
  'broadcasts.create',
  'broadcasts.update',
  'broadcasts.preview',
  'broadcasts.approve',
  'broadcasts.publish',
  'broadcasts.cancel',
  'observability.read',
]

export const ROLE_SEEDS = {
  support: {
    name: 'Support',
    description: 'Customer support cases and masked account context.',
    system: true,
    permissions: SUPPORT_PERMISSIONS,
  },
  billing: {
    name: 'Billing',
    description: 'Commercial plans and billing annotations.',
    system: true,
    permissions: BILLING_PERMISSIONS,
  },
  operations: {
    name: 'Operations',
    description: 'Operational diagnostics and controlled application actions.',
    system: true,
    permissions: OPERATIONS_PERMISSIONS,
  },
  analyst: {
    name: 'Analyst',
    description: 'Read-only operational aggregates.',
    system: true,
    permissions: ['users.read', 'jobs.read_metadata', 'applications.read', 'observability.read'] as const,
  },
  security_admin: {
    name: 'Security admin',
    description: 'Internal access, sessions, and audit review.',
    system: true,
    permissions: SECURITY_PERMISSIONS,
  },
  platform_admin: {
    name: 'Platform admin',
    description: 'Platform settings and broadcast approvals.',
    system: true,
    permissions: PLATFORM_PERMISSIONS,
  },
  super_admin: {
    name: 'Super admin',
    description: 'Emergency platform owner with all allow-listed permissions.',
    system: true,
    permissions: ADMIN_PERMISSION_KEYS,
  },
} satisfies Record<string, RoleSeed>

export function validatePermissionList(values: unknown): Permission[] {
  if (!Array.isArray(values)) throw new Error('Permissions must be an array')

  const result: Permission[] = []
  const known = new Set<string>(ADMIN_PERMISSION_KEYS)
  for (const value of values) {
    if (typeof value !== 'string') throw new Error('Permission keys must be strings')
    const key = value.trim()
    if (!key) continue
    if (!known.has(key)) throw new Error(`Unknown admin permission: ${key}`)
    if (!result.includes(key as Permission)) result.push(key as Permission)
  }
  return result
}

export interface AdminRoleActor {
  roleKey: string
  permissions: readonly Permission[]
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
  if (!actor.permissions.includes('admin_roles.manage')) {
    return { ok: false, error: 'Missing admin_roles.manage permission' }
  }

  let permissions: Permission[]
  try {
    permissions = validatePermissionList(nextPermissions)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Invalid permissions' }
  }

  const actorPermissions = new Set(actor.permissions)
  if (permissions.some(permission => !actorPermissions.has(permission))) {
    return { ok: false, error: 'Cannot grant a permission you do not hold' }
  }

  if (
    target.key === 'super_admin'
    && target.isLastSuperAdmin
    && !permissions.includes('admin_roles.manage')
  ) {
    return { ok: false, error: 'The last super admin must retain admin management permissions' }
  }

  return { ok: true, permissions }
}
