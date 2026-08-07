import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isPermission, SYSTEM_ROLES } from './permissions'

describe('admin permissions', () => {
  it('keeps internal privileges separate from commercial plans', () => {
    const support = SYSTEM_ROLES.find((role) => role.key === 'support')
    const superAdmin = SYSTEM_ROLES.find((role) => role.key === 'super_admin')
    expect(support?.permissions).toContain('support_cases.reply')
    expect(support?.permissions).not.toContain('users.update_preferences')
    expect(support?.permissions).not.toContain('broadcasts.publish')
    expect(superAdmin?.permissions).toContain('observability.read')
    expect(superAdmin?.permissions).toContain('users.update_preferences')
    expect(isPermission('pro')).toBe(false)
    expect(isPermission('users.read')).toBe(true)
    expect(isPermission('users.update_preferences')).toBe(true)
  })

  it('migrates the preference-write permission only to super administrators', () => {
    const migration = readFileSync(
      new URL('../../../prisma/migrations/20260807110000_add_user_preferences_admin_permission/migration.sql', import.meta.url),
      'utf8',
    )

    expect(migration).toContain("'super_admin'")
    expect(migration).not.toContain("'support'")
  })
})
