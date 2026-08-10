import { describe, expect, it } from 'vitest'
import { groupPermissions } from './AccessPage'

describe('access permission groups', () => {
  it('groups the catalogue by permission domain in stable order', () => {
    expect(groupPermissions([
      { key: 'users.read', domain: 'users', label: 'read' },
      { key: 'admin_members.read', domain: 'admin_members', label: 'read' },
      { key: 'users.suspend', domain: 'users', label: 'suspend' },
    ])).toEqual([
      { domain: 'admin_members', items: [{ key: 'admin_members.read', domain: 'admin_members', label: 'read' }] },
      { domain: 'users', items: [{ key: 'users.read', domain: 'users', label: 'read' }, { key: 'users.suspend', domain: 'users', label: 'suspend' }] },
    ])
  })
})
