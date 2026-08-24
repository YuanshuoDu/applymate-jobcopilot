import { createHash } from 'node:crypto'
import { Redis as UpstashRedis } from '@upstash/redis'
import { Redis as IORedis } from 'ioredis'

const KEY_PREFIX = 'applymate:discovery:v1:'
const DEFAULT_TTL_SECONDS = 15 * 60
const MAX_LOCAL_ENTRIES = 500

type CacheBackend = {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>
}

type LocalEntry = { value: unknown; expiresAt: number }

const localCache = new Map<string, LocalEntry>()
const pending = new Map<string, Promise<unknown>>()
let backendInitialized = false
let backend: CacheBackend | null = null

export type DiscoveryCacheIdentity = {
  query: Record<string, string | number | boolean | null | undefined>
  providers: readonly string[]
  credentialScope: string
}

export type CacheLookup<T> = {
  value: T
  layer: 'memory' | 'redis'
}

export type SingleflightResult<T> = {
  value: T
  joined: boolean
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

function normalize(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? '1' : '0'
  return String(value).trim().toLowerCase().replace(/\s+/g, ' ')
}

function stableQuery(query: DiscoveryCacheIdentity['query']): string {
  return Object.keys(query).sort().map(key => `${key}=${normalize(query[key])}`).join('&')
}

export function createDiscoveryCacheKey(identity: DiscoveryCacheIdentity): string {
  const payload = [
    stableQuery(identity.query),
    [...identity.providers].map(normalize).sort().join(','),
    normalize(identity.credentialScope),
  ].join('|')
  return `${KEY_PREFIX}${digest(payload)}`
}

export function credentialCacheScope(input: {
  userId: string
  providerScopes: Record<string, 'platform' | 'user' | 'public'>
}): string {
  const scopes = Object.keys(input.providerScopes).sort().map(provider => {
    const scope = input.providerScopes[provider]
    return scope === 'user' ? `${provider}:user:${digest(input.userId)}` : `${provider}:${scope}`
  })
  return digest(scopes.join('|'))
}

function getBackend(): CacheBackend | null {
  if (backendInitialized) return backend
  backendInitialized = true
  if (process.env.NODE_ENV === 'test') return null

  const restUrl = process.env.UPSTASH_REDIS_REST_URL?.trim()
  const restToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
  if (restUrl && restToken) {
    const client = new UpstashRedis({ url: restUrl, token: restToken })
    backend = {
      get: <T>(key: string) => client.get<T>(key),
      set: async <T>(key: string, value: T, ttlSeconds: number) => {
        await client.set(key, value, { ex: ttlSeconds })
      },
    }
    return backend
  }

  const redisUrl = process.env.REDIS_URL?.trim()
  if (!redisUrl) return null
  const client = new IORedis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true })
  backend = {
    get: async <T>(key: string) => {
      const raw = await client.get(key)
      if (raw === null) return null
      return JSON.parse(raw) as T
    },
    set: async <T>(key: string, value: T, ttlSeconds: number) => {
      await client.set(key, JSON.stringify(value), 'EX', ttlSeconds)
    },
  }
  return backend
}

function localGet<T>(key: string): CacheLookup<T> | null {
  const entry = localCache.get(key)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    localCache.delete(key)
    return null
  }
  return { value: entry.value as T, layer: 'memory' }
}

function localSet<T>(key: string, value: T, ttlSeconds: number): void {
  if (localCache.size >= MAX_LOCAL_ENTRIES && !localCache.has(key)) {
    const oldest = [...localCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0]
    if (oldest) localCache.delete(oldest[0])
  }
  localCache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1_000 })
}

export async function getDiscoveryCache<T>(key: string): Promise<CacheLookup<T> | null> {
  const local = localGet<T>(key)
  if (local) return local
  const store = getBackend()
  if (!store) return null
  try {
    const value = await store.get<T>(key)
    if (value === null) return null
    localSet(key, value, DEFAULT_TTL_SECONDS)
    return { value, layer: 'redis' }
  } catch (error) {
    console.warn('[discovery-cache] Redis read failed; continuing without shared cache', error instanceof Error ? error.message : 'unknown')
    return null
  }
}

export async function setDiscoveryCache<T>(key: string, value: T, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<void> {
  const ttl = Math.max(1, Math.trunc(ttlSeconds))
  localSet(key, value, ttl)
  const store = getBackend()
  if (!store) return
  try {
    await store.set(key, value, ttl)
  } catch (error) {
    console.warn('[discovery-cache] Redis write failed; retaining local cache only', error instanceof Error ? error.message : 'unknown')
  }
}

export async function runDiscoverySingleflight<T>(key: string, task: () => Promise<T>): Promise<SingleflightResult<T>> {
  const current = pending.get(key)
  if (current) return { value: await current as T, joined: true }

  const promise = Promise.resolve().then(task)
  pending.set(key, promise)
  try {
    return { value: await promise, joined: false }
  } finally {
    if (pending.get(key) === promise) pending.delete(key)
  }
}

export function clearDiscoveryCacheForTests(): void {
  localCache.clear()
  pending.clear()
  backend = null
  backendInitialized = false
}
