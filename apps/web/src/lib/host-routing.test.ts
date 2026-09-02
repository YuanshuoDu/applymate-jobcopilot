import { describe, expect, it } from 'vitest'
import { adminOrigin, isAdminApiPath, isAdminAuthApiPath, isAdminHost, isAdminInvitationPath, isAdminPath, isAuthPath, isLocalHost } from './host-routing'

describe('host routing', () => {
  it('recognizes only the configured administrator host', () => {
    expect(isAdminHost('admin.applymate.site')).toBe(true)
    expect(isAdminHost('ADMIN.APPLYMATE.SITE')).toBe(true)
    expect(isAdminHost('applymate.site')).toBe(false)
  })

  it('classifies admin, auth, and admin API paths', () => {
    expect(isAdminPath('/admin')).toBe(true)
    expect(isAdminPath('/admin/users')).toBe(true)
    expect(isAdminPath('/invite/admin')).toBe(true)
    expect(isAdminPath('/dashboard')).toBe(false)
    expect(isAdminInvitationPath('/invite/admin')).toBe(true)
    expect(isAdminInvitationPath('/invite/admin/')).toBe(true)
    expect(isAdminInvitationPath('/invite/administrator')).toBe(false)
    expect(isAuthPath('/login')).toBe(true)
    expect(isAuthPath('/api/auth/session')).toBe(true)
    expect(isAdminAuthApiPath('/api/auth/callback/credentials')).toBe(true)
    expect(isAdminAuthApiPath('/api/auth/providers')).toBe(true)
    expect(isAdminAuthApiPath('/api/auth/callback/google')).toBe(false)
    expect(isAuthPath('/register')).toBe(false)
    expect(isAdminApiPath('/api/admin/v1/users')).toBe(true)
    expect(isAdminApiPath('/api/admin/invitations/register')).toBe(true)
    expect(isAdminApiPath('/api/admin/invitations/accept')).toBe(true)
    expect(isAdminApiPath('/api/users')).toBe(false)
  })

  it('builds the administrator origin without preserving a preview host', () => {
    expect(adminOrigin('https://web-preview.vercel.app/admin')).toBe('https://admin.applymate.site')
  })

  it('keeps the local administrator origin on the local development host', () => {
    expect(adminOrigin('http://localhost:3000/admin')).toBe('http://localhost:3000')
  })

  it('recognizes local development hosts', () => {
    expect(isLocalHost('localhost:3000')).toBe(true)
    expect(isLocalHost('applymate.site')).toBe(false)
  })
})
