import { afterEach, describe, expect, it, vi } from 'vitest'
import { ATS_POLICIES } from '@jobcopilot/shared'
import { acquire, DISCOVERY_POLICIES, POLICIES } from './policies'

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

  it('registers CleanJobData as a discovery provider with an explicit host ceiling', () => {
    expect(DISCOVERY_POLICIES.cleanjobdata).toEqual({ host: 'api.cleanjobdata.com', rps: 1 })
    expect(POLICIES.cleanjobdata).toEqual(DISCOVERY_POLICIES.cleanjobdata)
    expect(ATS_POLICIES).not.toHaveProperty('cleanjobdata')
  })

  it('registers Fantastic Jobs with its API host ceiling', () => {
    expect(DISCOVERY_POLICIES.fantasticjobs).toEqual({ host: 'data.fantastic.jobs', rps: 1 })
    expect(POLICIES.fantasticjobs).toEqual(DISCOVERY_POLICIES.fantasticjobs)
  })

  it('registers Ashby with a conservative public API ceiling', () => {
    expect(DISCOVERY_POLICIES.ashby).toEqual({ host: 'api.ashbyhq.com', rps: 1 })
    expect(POLICIES.ashby).toEqual(DISCOVERY_POLICIES.ashby)
    expect(ATS_POLICIES).not.toHaveProperty('ashby')
  })
})
