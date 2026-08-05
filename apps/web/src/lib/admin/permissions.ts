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
