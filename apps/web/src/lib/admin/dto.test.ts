import { describe, expect, it } from 'vitest'
import { maskEmail, maskName, toAdminMemberDto, toAdminRoleDto, toAdminUserDto } from './dto'

describe('admin DTO redaction', () => {
  it('masks controlled identity fields', () => {
    expect(maskEmail('ada.lovelace@example.com')).toBe('a***@example.com')
    expect(maskName('Ada Lovelace')).toBe('A*** L***')
  })

  it('returns only approved member metadata', () => {
    const result = toAdminMemberDto({
      id: 'membership_1',
      userId: 'user_1',
      status: 'active',
      mfaLevel: 'none',
      sessionVersion: 3,
      grantedAt: new Date('2026-08-01T00:00:00.000Z'),
      role: { key: 'support', name: 'Support', permissions: ['support_cases.read'] },
      user: {
        id: 'user_1',
        email: 'ada.lovelace@example.com',
        name: 'Ada Lovelace',
        plan: 'pro',
        password: 'hash',
        apiKeys: { rapidapiKey: 'secret' },
        preferences: { aiSettings: { keys: { openai: 'secret' } } },
      },
    })

    expect(result).toEqual({
      id: 'membership_1',
      userId: 'user_1',
      status: 'active',
      mfaLevel: 'none',
      sessionVersion: 3,
      grantedAt: '2026-08-01T00:00:00.000Z',
      role: { key: 'support', name: 'Support', permissions: ['support_cases.read'] },
      user: { id: 'user_1', email: 'a***@example.com', name: 'A*** L***', plan: 'pro' },
    })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain('password')
  })

  it('does not serialize unknown role fields', () => {
    expect(toAdminRoleDto({ id: 'role_1', key: 'support', name: 'Support', permissions: ['users.read'], system: true, version: 4, internalSecret: 'x' })).toEqual({
      id: 'role_1',
      key: 'support',
      name: 'Support',
      permissions: ['users.read'],
      system: true,
      version: 4,
    })
  })

  it('masks user identity while keeping operational counts and omitting content', () => {
    const result = toAdminUserDto({
      id: 'user_1', email: 'ada.lovelace@example.com', name: 'Ada Lovelace', plan: 'pro', accountStatus: 'active',
      createdAt: new Date('2026-08-01T00:00:00.000Z'), updatedAt: new Date('2026-08-02T00:00:00.000Z'), location: 'Berlin, Germany',
      _count: { resumes: 2, jobs: 4, applicationTasks: 1 }, personaFields: { secret: 'x' }, password: 'hash',
    })
    expect(result).toMatchObject({ id: 'user_1', email: 'a***@example.com', name: 'A*** L***', plan: 'pro', accountStatus: 'active', counts: { resumes: 2, jobs: 4, applicationTasks: 1 } })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain('password')
  })
})
