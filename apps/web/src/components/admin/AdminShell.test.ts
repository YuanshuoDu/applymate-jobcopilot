import { describe, expect, it } from 'vitest'
import { filterAdminNav } from './AdminShell'

describe('admin navigation', () => {
  it('only exposes links for permissions held by the active administrator', () => {
    const items = filterAdminNav(['admin_members.read'])
    expect(items.map(item => item.href)).toEqual(['/admin', '/admin/access'])
    expect(items.some(item => item.href === '/admin/users')).toBe(false)
  })
})
