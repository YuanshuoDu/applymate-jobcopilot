/**
 * Rate limiter tests — verifies sliding window correctness.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { checkRateLimit } from '@/lib/rate-limit'

describe('checkRateLimit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('allows requests within the limit', () => {
    for (let i = 0; i < 9; i++) {
      const result = checkRateLimit('test-key')
      expect(result.ok).toBe(true)
    }
  })

  it('blocks requests exceeding the default limit (10/min)', () => {
    for (let i = 0; i < 10; i++) {
      const result = checkRateLimit('test-key-2')
      expect(result.ok).toBe(true)
    }

    // 11th request should be blocked
    const blocked = checkRateLimit('test-key-2')
    expect(blocked.ok).toBe(false)
    const blockedResult = blocked as { ok: false; retryAfter: number }
    expect(blockedResult.retryAfter).toBeGreaterThan(0)
    expect(blockedResult.retryAfter).toBeLessThanOrEqual(60)
  })

  it('respects custom limits', () => {
    for (let i = 0; i < 3; i++) {
      expect(checkRateLimit('custom-key', 3, 60_000).ok).toBe(true)
    }
    expect(checkRateLimit('custom-key', 3, 60_000).ok).toBe(false)
  })

  it('resets after the window expires', () => {
    for (let i = 0; i < 10; i++) {
      checkRateLimit('reset-key')
    }

    expect(checkRateLimit('reset-key').ok).toBe(false)

    // Advance past the window
    vi.advanceTimersByTime(61_000)

    expect(checkRateLimit('reset-key').ok).toBe(true)
  })

  it('uses independent keys', () => {
    for (let i = 0; i < 10; i++) {
      checkRateLimit('key-a')
    }
    expect(checkRateLimit('key-a').ok).toBe(false)
    expect(checkRateLimit('key-b').ok).toBe(true)
  })

  it('returns a retryAfter value that decreases over time', () => {
    for (let i = 0; i < 10; i++) {
      checkRateLimit('decay-key')
    }
    const blocked = checkRateLimit('decay-key')
    expect(blocked.ok).toBe(false)
    expect((blocked as { ok: false; retryAfter: number }).retryAfter).toBeGreaterThan(55) // within 5s of 60s window

    vi.advanceTimersByTime(30_000)

    const stillBlocked = checkRateLimit('decay-key')
    expect(stillBlocked.ok).toBe(false)
    expect((stillBlocked as { ok: false; retryAfter: number }).retryAfter).toBeLessThan(31)
  })
})
