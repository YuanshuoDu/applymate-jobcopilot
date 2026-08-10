import { describe, expect, it } from 'vitest'
import { adminJson } from './route-utils'

describe('adminJson', () => {
  it('sets request correlation and no-store cache headers', async () => {
    const response = adminJson({ ok: true }, 201, 'request_1')
    expect(response.status).toBe(201)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('x-request-id')).toBe('request_1')
  })
})
