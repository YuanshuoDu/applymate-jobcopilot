import { describe, expect, it } from 'vitest'
import { filterAdminNav } from './AdminShell'

describe('admin navigation', () => {
  it('only exposes links for permissions held by the active administrator', () => {
    const items = filterAdminNav(['admin_members.read'])
    expect(items.map(item => item.href)).toEqual(['/admin/access', '/admin/security'])
    expect(items.some(item => item.href === '/admin/users')).toBe(false)
  })

  it('exposes WebAuthn self-service to a platform administrator without break-glass access', () => {
    const items = filterAdminNav(['feature_flags.approve'])
    expect(items.some(item => item.href === '/admin/security')).toBe(true)
  })
})
