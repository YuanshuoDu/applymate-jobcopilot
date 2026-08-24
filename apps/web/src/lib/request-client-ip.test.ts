import { describe, expect, it } from 'vitest'
import { getClientIp } from './request-client-ip'

describe('getClientIp', () => {
  it('uses the first valid forwarded address', () => {
    expect(getClientIp(new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.2' }))).toBe('203.0.113.7')
  })

  it('falls back to x-real-ip and rejects spoof-like values', () => {
    expect(getClientIp(new Headers({ 'x-forwarded-for': 'not-an-ip', 'x-real-ip': '2001:db8::1' }))).toBe('2001:db8::1')
    expect(getClientIp(new Headers({ 'x-forwarded-for': 'not-an-ip', 'x-real-ip': '1.1.1.1:1234' }))).toBeUndefined()
  })
})
