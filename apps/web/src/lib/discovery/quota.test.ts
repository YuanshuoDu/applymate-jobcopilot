import { describe, expect, it } from 'vitest'
import { circuitIsOpen, quotaBand } from './quota'

describe('discovery quota policy', () => {
  it('maps remaining capacity to quota bands', () => {
    expect(quotaBand(0, 100)).toBe('green')
    expect(quotaBand(75, 100)).toBe('amber')
    expect(quotaBand(95, 100)).toBe('red')
    expect(quotaBand(100, 100)).toBe('exhausted')
  })

  it('opens a circuit for a recent provider failure or sustained errors', () => {
    const now = new Date('2026-08-24T12:00:00Z')
    expect(circuitIsOpen([{ status: 'error', httpStatus: 429, rateLimitLimit: 50, rateLimitRemaining: 0, createdAt: new Date('2026-08-24T11:58:00Z') }], now)).toBe(true)
    expect(circuitIsOpen([
      { status: 'error', httpStatus: 500, rateLimitLimit: null, rateLimitRemaining: null, createdAt: new Date('2026-08-24T11:00:00Z') },
      { status: 'error', httpStatus: 503, rateLimitLimit: null, rateLimitRemaining: null, createdAt: new Date('2026-08-24T11:01:00Z') },
      { status: 'success', httpStatus: 200, rateLimitLimit: null, rateLimitRemaining: null, createdAt: new Date('2026-08-24T11:02:00Z') },
    ], now)).toBe(false)
  })
})
