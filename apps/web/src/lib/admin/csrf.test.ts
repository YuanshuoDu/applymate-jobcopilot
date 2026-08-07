import { describe, expect, it } from 'vitest'

import { validateAdminWrite } from './csrf'

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
})
