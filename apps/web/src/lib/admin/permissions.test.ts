import { describe, expect, it } from 'vitest'
import { isPermission, SYSTEM_ROLES } from './permissions'

describe('admin permissions', () => {
  it('keeps internal privileges separate from commercial plans', () => {
    const support = SYSTEM_ROLES.find((role) => role.key === 'support')
    const superAdmin = SYSTEM_ROLES.find((role) => role.key === 'super_admin')
    expect(support?.permissions).toContain('support_cases.reply')
    expect(support?.permissions).not.toContain('broadcasts.publish')
    expect(superAdmin?.permissions).toContain('observability.read')
    expect(isPermission('pro')).toBe(false)
    expect(isPermission('users.read')).toBe(true)
  })
})
