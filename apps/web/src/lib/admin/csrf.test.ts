import { describe, expect, it } from 'vitest'
import { validateAdminWriteRequest } from './csrf'

describe('validateAdminWriteRequest', () => {
  it('accepts safe methods without a CSRF origin header', () => {
    expect(validateAdminWriteRequest(new Request('http://localhost/api/admin/v1/access/roles'))).toEqual({ ok: true })
  })

  it('accepts a mutating request from the configured origin', () => {
    process.env.AUTH_CANONICAL_URL = 'https://applymate.site'
    const request = new Request('https://applymate.site/api/admin/v1/access/roles', {
      method: 'POST',
      headers: { Origin: 'https://applymate.site' },
    })
    expect(validateAdminWriteRequest(request)).toEqual({ ok: true })
  })

  it('rejects a mutating request from an untrusted origin', () => {
    process.env.AUTH_CANONICAL_URL = 'https://applymate.site'
    const request = new Request('https://applymate.site/api/admin/v1/access/roles', {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
    })
    expect(validateAdminWriteRequest(request)).toEqual({
      ok: false,
      status: 403,
      code: 'CSRF_ORIGIN_MISMATCH',
    })
  })
})
