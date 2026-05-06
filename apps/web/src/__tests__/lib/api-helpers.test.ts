/**
 * API helpers tests — ok(), err(), isErrorResponse
 */
import { describe, it, expect, vi } from 'vitest'

// Prevent next-auth from loading in test env (it uses CJS require('next/server') without .js)
vi.mock('@/lib/auth', () => ({ auth: vi.fn().mockResolvedValue(null) }))

import { ok, err, isErrorResponse } from '@/lib/api-helpers'

describe('ok()', () => {
  it('returns a response with status 200 and JSON body', async () => {
    const res = ok({ message: 'success', data: 42 })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.message).toBe('success')
    expect(body.data).toBe(42)
  })

  it('handles null data', async () => {
    const res = ok(null)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toBe(null)
  })

  it('sets Content-Type header', () => {
    const res = ok({})
    expect(res.headers.get('Content-Type')).toContain('application/json')
  })
})

describe('err()', () => {
  it('returns a response with given status and JSON error', async () => {
    const res = err('Bad request', 400)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Bad request')
  })

  it('defaults to 400 status', async () => {
    const res = err('Validation error')
    expect(res.status).toBe(400)
  })

  it('returns valid JSON for empty messages', async () => {
    const res = err('', 422)
    const body = await res.json()
    expect(body.error).toBe('')
  })

  it('supports status 429 for rate limiting', async () => {
    const res = err('Rate limited', 429)
    expect(res.status).toBe(429)
  })
})

describe('isErrorResponse()', () => {
  it('returns true for NextResponse error instances', () => {
    const authError = err('Unauthorized', 401)
    expect(isErrorResponse(authError)).toBe(true)
  })

  it('returns false for plain auth result objects', () => {
    expect(isErrorResponse({ userId: 'test-123' })).toBe(false)
  })

  it('returns false for null and undefined', () => {
    expect(isErrorResponse(null)).toBe(false)
    expect(isErrorResponse(undefined)).toBe(false)
  })
})
