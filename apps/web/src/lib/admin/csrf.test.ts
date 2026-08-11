import { afterEach, describe, expect, it, vi } from 'vitest'

import { validateAdminWrite, validateAdminWriteRequest } from './csrf'

afterEach(() => vi.unstubAllEnvs())

function request(headers: Record<string, string>) {
  return new Request('https://applymate.test/api/admin/v1/plans', { method: 'PATCH', headers })
}

describe('validateAdminWrite', () => {
  it('accepts a same-origin request with a non-empty idempotency key', () => {
    expect(validateAdminWrite(request({ Origin: 'https://applymate.test', Host: 'applymate.test', 'Idempotency-Key': 'key-1' }))).toBeNull()
  })

  it('rejects malformed and cross-origin origins without throwing', () => {
    expect(validateAdminWrite(request({ Origin: 'not a url', Host: 'applymate.test', 'Idempotency-Key': 'key-1' }))).toBeInstanceOf(Response)
    expect(validateAdminWrite(request({ Origin: 'https://evil.test', Host: 'applymate.test', 'Idempotency-Key': 'key-1' }))).toMatchObject({ status: 403 })
  })

  it('rejects blank or oversized idempotency keys', () => {
    expect(validateAdminWrite(request({ Origin: 'https://applymate.test', Host: 'applymate.test', 'Idempotency-Key': '   ' }))).toMatchObject({ status: 400 })
    expect(validateAdminWrite(request({ Origin: 'https://applymate.test', Host: 'applymate.test', 'Idempotency-Key': 'x'.repeat(129) }))).toMatchObject({ status: 400 })
  })

  it('uses the administrator origin rather than the public application origin', () => {
    vi.stubEnv('ADMIN_APP_URL', 'https://admin.applymate.site')
    const request = new Request('https://admin.applymate.site/api/admin/v1/plans', {
      method: 'PATCH',
      headers: { Origin: 'https://admin.applymate.site' },
    })
    expect(validateAdminWriteRequest(request)).toEqual({ ok: true })

    const publicOriginRequest = new Request('https://admin.applymate.site/api/admin/v1/plans', {
      method: 'PATCH',
      headers: { Origin: 'https://applymate.site' },
    })
    expect(validateAdminWriteRequest(publicOriginRequest)).toEqual({ ok: false, status: 403, code: 'CSRF_ORIGIN_MISMATCH' })
  })
})
