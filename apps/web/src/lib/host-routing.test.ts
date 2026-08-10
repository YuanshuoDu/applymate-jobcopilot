import { describe, expect, it } from 'vitest'
import { adminOrigin, isAdminApiPath, isAdminHost, isAdminPath, isAuthPath, isLocalHost } from './host-routing'

describe('host routing', () => {
  it('recognizes only the configured administrator host', () => {
    expect(isAdminHost('admin.applymate.site')).toBe(true)
    expect(isAdminHost('ADMIN.APPLYMATE.SITE')).toBe(true)
    expect(isAdminHost('applymate.site')).toBe(false)
  })

  it('classifies admin, auth, and admin API paths', () => {
    expect(isAdminPath('/admin')).toBe(true)
    expect(isAdminPath('/admin/users')).toBe(true)
    expect(isAdminPath('/dashboard')).toBe(false)
    expect(isAuthPath('/login')).toBe(true)
    expect(isAuthPath('/api/auth/session')).toBe(true)
    expect(isAuthPath('/register')).toBe(false)
    expect(isAdminApiPath('/api/admin/v1/users')).toBe(true)
    expect(isAdminApiPath('/api/users')).toBe(false)
  })

  it('builds the administrator origin without preserving a preview host', () => {
    expect(adminOrigin('https://web-preview.vercel.app/admin')).toBe('https://admin.applymate.site')
  })

  it('recognizes local development hosts', () => {
    expect(isLocalHost('localhost:3000')).toBe(true)
    expect(isLocalHost('applymate.site')).toBe(false)
  })
})
