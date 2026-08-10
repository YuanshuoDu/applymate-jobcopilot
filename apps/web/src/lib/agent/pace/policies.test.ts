import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquire } from './policies'

describe('ATS pace policies', () => {
  afterEach(() => vi.useRealTimers())

  it('uses a configured per-user rate without exceeding the hard source ceiling', async () => {
    vi.useFakeTimers()
    const timeout = vi.spyOn(globalThis, 'setTimeout')

    const pending = acquire({ ats: 'greenhouse', rps: 1 })

    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    await pending
  })
})
