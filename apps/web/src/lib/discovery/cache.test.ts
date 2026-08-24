import { describe, expect, it, beforeEach } from 'vitest'
import { clearDiscoveryCacheForTests, createDiscoveryCacheKey, credentialCacheScope, getDiscoveryCache, runDiscoverySingleflight, setDiscoveryCache } from './cache'

describe('discovery cache', () => {
  beforeEach(() => clearDiscoveryCacheForTests())

  it('normalizes equivalent queries and keeps credential scope in the key', () => {
    const first = createDiscoveryCacheKey({ query: { q: ' Engineer ', location: 'Berlin' }, providers: ['cleanjobdata', 'adzuna'], credentialScope: 'platform' })
    const second = createDiscoveryCacheKey({ query: { location: 'berlin', q: 'engineer' }, providers: ['adzuna', 'cleanjobdata'], credentialScope: 'platform' })
    const user = credentialCacheScope({ userId: 'user-1', providerScopes: { adzuna: 'user', cleanjobdata: 'platform' } })
    const otherUser = credentialCacheScope({ userId: 'user-2', providerScopes: { adzuna: 'user', cleanjobdata: 'platform' } })
    expect(first).toBe(second)
    expect(user).not.toBe(otherUser)
  })

  it('shares a result through the cache and expires it', async () => {
    const key = createDiscoveryCacheKey({ query: { q: 'engineer' }, providers: [], credentialScope: 'platform' })
    await setDiscoveryCache(key, { jobs: 2 }, 60)
    await expect(getDiscoveryCache<{ jobs: number }>(key)).resolves.toEqual({ value: { jobs: 2 }, layer: 'memory' })
  })

  it('joins concurrent work and runs the task once', async () => {
    const key = 'singleflight-test'
    let calls = 0
    const task = () => new Promise<number>(resolve => setTimeout(() => resolve(++calls), 10))
    const [first, second] = await Promise.all([runDiscoverySingleflight(key, task), runDiscoverySingleflight(key, task)])
    expect(calls).toBe(1)
    expect(first.value).toBe(1)
    expect(second.value).toBe(1)
    expect([first.joined, second.joined].sort()).toEqual([false, true])
  })
})
