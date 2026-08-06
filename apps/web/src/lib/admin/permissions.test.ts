import { describe, expect, it } from 'vitest'
import {
  ADMIN_PERMISSION_KEYS,
  ROLE_SEEDS,
  canEditRole,
  validatePermissionList,
} from './permissions'

describe('admin permission catalogue', () => {
  it('contains the permissions required by the admin console', () => {
    expect(ADMIN_PERMISSION_KEYS).toEqual(expect.arrayContaining([
      'admin_members.manage',
      'admin_roles.manage',
      'sessions.revoke',
      'users.suspend',
      'billing.update',
      'broadcasts.publish',
      'support_cases.assign',
      'observability.read',
    ]))
  })

  it('normalizes and rejects permission keys outside the catalogue', () => {
    expect(validatePermissionList([' users.read ', 'users.read', 'billing.read'])).toEqual([
      'users.read',
      'billing.read',
    ])
    expect(() => validatePermissionList(['users.read', 'secrets.read'])).toThrow('Unknown admin permission')
  })

  it('provides explicit seeded role permissions without inheritance', () => {
    expect(ROLE_SEEDS.support.permissions).toContain('support_cases.reply')
    expect(ROLE_SEEDS.support.permissions).not.toContain('billing.update')
    expect(ROLE_SEEDS.super_admin.permissions).toEqual([...ADMIN_PERMISSION_KEYS])
  })
})

describe('canEditRole', () => {
  const actor = {
    permissions: ['admin_roles.manage', 'users.read'] as const,
    roleKey: 'platform_admin',
  }

  it('rejects granting a permission the actor does not hold', () => {
    expect(canEditRole(actor, { key: 'support', isLastSuperAdmin: false }, ['billing.update'])).toEqual({
      ok: false,
      error: 'Cannot grant a permission you do not hold',
    })
  })

  it('protects the last super admin from losing management access', () => {
    const superActor = {
      permissions: [...ADMIN_PERMISSION_KEYS] as typeof ADMIN_PERMISSION_KEYS,
      roleKey: 'super_admin',
    }
    expect(canEditRole(superActor, { key: 'super_admin', isLastSuperAdmin: true }, ['users.read'])).toEqual({
      ok: false,
      error: 'The last super admin must retain admin management permissions',
    })
  })
})
