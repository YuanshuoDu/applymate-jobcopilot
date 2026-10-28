import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { NextRequest, NextResponse } from 'next/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ requireAuth: vi.fn(), pinnedFetch: vi.fn() }))
vi.mock('@/lib/api-helpers', () => ({
  requireAuth: auth.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
}))
// A fail-closed transport stub ensures the integration never contacts a provider.
vi.mock('@jobcopilot/shared/pinned-outbound', () => ({ pinnedFetch: auth.pinnedFetch }))

/** Refuse every database except the designated disposable loopback instance. */
function disposableUrl(): string | null {
  const value = process.env.PERSONAL_USAGE_PG_TEST_URL
  if (!value) {
    if (process.env.PERSONAL_USAGE_PG_TEST_REQUIRED === 'true') throw new Error('A disposable local PostgreSQL instance is required')
    return null
  }
  const url = new URL(value)
  if (process.env.PERSONAL_USAGE_PG_TEST_DISPOSABLE !== 'true' ||
    url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' || url.port !== '56372' ||
    url.username !== 'postgres' || url.password || url.pathname !== '/personal_usage_disposable' ||
    url.search || url.hash) throw new Error('Only the designated disposable local PostgreSQL URL is allowed')
  return value
}

const databaseUrl = disposableUrl()
const describePg = databaseUrl ? describe : describe.skip
const suffix = randomUUID().replaceAll('-', '')
const schema = 'personal_usage_handler_' + suffix
const role = 'personal_usage_role_' + suffix
const userA = 'owner-a-' + suffix
const userB = 'owner-b-' + suffix
const userEmpty = 'owner-empty-' + suffix
const userWriter = 'owner-writer-' + suffix
const userShared = 'owner-shared-' + suffix
const activityIds = Array.from({ length: 14 }, (_, i) => 'activity-' + suffix + '-' + String(i).padStart(2, '0'))
const foreignActivity = 'foreign-' + suffix
const usageIds = ['success', 'error', 'reserved', 'released', 'admin', 'probe', 'old', 'foreign'].map(name => name + '-' + suffix)
const cache = globalThis as unknown as { prisma?: PrismaClient }
const oldPrisma = cache.prisma
const priorEnvironment = { DATABASE_URL: process.env.DATABASE_URL, RLS_RUNTIME_MODE: process.env.RLS_RUNTIME_MODE, RLS_CANDIDATE_ROLE: process.env.RLS_CANDIDATE_ROLE }
let admin: PrismaClient | undefined
let fixture: PrismaClient | undefined
let realDb: PrismaClient | undefined
let usageHandler: typeof import('./usage/route').GET
let activityHandler: typeof import('./activity/route').GET
let scope: typeof import('@/lib/db/tenant-store').runWithTenantContext
let schemaCreated = false
let roleCreated = false
let usageTableCreated = false
let activityTableCreated = false

function restoreEnv(key: keyof typeof priorEnvironment) {
  const value = priorEnvironment[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

describePg('personal usage and activity handlers with disposable PostgreSQL', () => {
  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: databaseUrl! } } })
    await admin.$executeRawUnsafe('CREATE SCHEMA "' + schema + '"')
    schemaCreated = true
    await admin.$executeRawUnsafe('CREATE ROLE "' + role + '" NOLOGIN')
    roleCreated = true
    const scoped = new URL(databaseUrl!)
    scoped.searchParams.set('schema', schema)
    scoped.searchParams.set('connection_limit', '1')
    fixture = new PrismaClient({ datasources: { db: { url: scoped.toString() } } })
    await fixture.$executeRawUnsafe("CREATE TABLE ai_usage_events (id text PRIMARY KEY, user_id text, feature_key text NOT NULL, provider text NOT NULL, model text NOT NULL, input_tokens integer NOT NULL, output_tokens integer NOT NULL, estimated_cost_usd double precision NOT NULL DEFAULT 0, latency_ms integer NOT NULL DEFAULT 0, status text NOT NULL, error_code text, credential_source text NOT NULL DEFAULT 'platform', runtime text NOT NULL, created_at timestamp(3) NOT NULL DEFAULT timezone('UTC', CURRENT_TIMESTAMP))")
    usageTableCreated = true
    await fixture.$executeRawUnsafe('CREATE TABLE "Activity" (id text PRIMARY KEY, "userId" text NOT NULL, text text NOT NULL, "createdAt" timestamp(3) NOT NULL)')
    activityTableCreated = true

    const recordedAt = new Date(Date.now() - 60_000)
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    const usage = [
      [usageIds[0], userA, 'coverLetter', 'model-a', 100, 20, 'web', 'success', recordedAt],
      [usageIds[1], userA, 'autoApply', 'model-b', 30, 5, 'worker', 'error', recordedAt],
      [usageIds[2], userA, 'agent', 'model-a', 100, 100, 'worker', 'reserved', recordedAt],
      [usageIds[3], userA, 'agent', 'model-a', 100, 100, 'worker', 'released', recordedAt],
      [usageIds[4], userA, 'agent', 'model-a', 100, 100, 'admin', 'success', recordedAt],
      [usageIds[5], userA, 'providerTest', 'model-a', 100, 100, 'web', 'success', recordedAt],
      [usageIds[6], userA, 'agent', 'model-a', 100, 100, 'web', 'success', old],
      [usageIds[7], userB, 'coverLetter', 'model-b', 999, 333, 'web', 'success', recordedAt],
    ] as const
    for (const [id, owner, feature, model, input, output, runtime, status, date] of usage) {
      await fixture.$executeRawUnsafe('INSERT INTO ai_usage_events (id, user_id, feature_key, provider, model, input_tokens, output_tokens, runtime, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', id, owner, feature, 'provider', model, input, output, runtime, status, date)
    }
    for (const id of activityIds) {
      await fixture.$executeRawUnsafe('INSERT INTO "Activity" (id, "userId", text, "createdAt") VALUES ($1,$2,$3,$4)', id, userA, 'same <original> text', recordedAt)
    }
    await fixture.$executeRawUnsafe('INSERT INTO "Activity" (id, "userId", text, "createdAt") VALUES ($1,$2,$3,$4)', foreignActivity, userB, 'FOREIGN PRIVATE TEXT', recordedAt)
    await fixture.$executeRawUnsafe('ALTER TABLE ai_usage_events ENABLE ROW LEVEL SECURITY')
    await fixture.$executeRawUnsafe("CREATE POLICY usage_owner ON ai_usage_events USING (user_id = current_setting('app.user_id', true))")
    await fixture.$executeRawUnsafe('ALTER TABLE "Activity" ENABLE ROW LEVEL SECURITY')
    await fixture.$executeRawUnsafe('CREATE POLICY activity_owner ON "Activity" USING ("userId" = current_setting(' + "'app.user_id'" + ', true))')
    await admin.$executeRawUnsafe('GRANT USAGE ON SCHEMA "' + schema + '" TO "' + role + '"')
    await admin.$executeRawUnsafe('GRANT SELECT ON "' + schema + '".ai_usage_events, "' + schema + '"."Activity" TO "' + role + '"')
    await admin.$executeRawUnsafe('GRANT INSERT ON "' + schema + '".ai_usage_events TO "' + role + '"')

    delete cache.prisma
    process.env.DATABASE_URL = scoped.toString()
    process.env.RLS_RUNTIME_MODE = 'on'
    process.env.RLS_CANDIDATE_ROLE = role
    auth.requireAuth.mockResolvedValue({ userId: userA })
    realDb = (await import('@/lib/db')).db
    await realDb.$executeRawUnsafe("SET TIME ZONE 'Asia/Tokyo'")
    const zone = await realDb.$queryRawUnsafe<Array<{ TimeZone: string }>>('SHOW TIME ZONE')
    expect(zone[0]?.TimeZone).toBe('Asia/Tokyo')
    scope = (await import('@/lib/db/tenant-store')).runWithTenantContext
    usageHandler = (await import('./usage/route')).GET
    activityHandler = (await import('./activity/route')).GET
  }, 30_000)

  afterAll(async () => {
    try {
      await realDb?.$disconnect()
      if (fixture && activityTableCreated) {
        await fixture.activity.deleteMany({ where: { id: { in: [...activityIds, foreignActivity] } } })
      }
      if (fixture && usageTableCreated) {
        await fixture.aiUsageEvent.deleteMany({ where: { OR: [{ id: { in: usageIds } }, { userId: { in: [userWriter, userShared] } }] } })
      }
      await fixture?.$disconnect()
      if (admin && schemaCreated) {
        if (activityTableCreated) await admin.$executeRawUnsafe('DROP TABLE "' + schema + '"."Activity"')
        if (usageTableCreated) await admin.$executeRawUnsafe('DROP TABLE "' + schema + '".ai_usage_events')
        if (roleCreated) await admin.$executeRawUnsafe('REVOKE USAGE ON SCHEMA "' + schema + '" FROM "' + role + '"')
        await admin.$executeRawUnsafe('DROP SCHEMA "' + schema + '"')
      }
      if (admin && roleCreated) await admin.$executeRawUnsafe('DROP ROLE "' + role + '"')
    } finally {
      await admin?.$disconnect()
      if (oldPrisma) cache.prisma = oldPrisma
      else delete cache.prisma
      for (const key of Object.keys(priorEnvironment) as Array<keyof typeof priorEnvironment>) restoreEnv(key)
    }
  }, 30_000)

  it('aggregates real admin inference and excludes reservations, model probes, and old records', async () => {
    auth.requireAuth.mockResolvedValue({ userId: userA })
    const response = await usageHandler(new NextRequest('http://localhost/api/me/usage?days=7&userId=' + userB))
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const a = await response.json()
    expect(a.ownerId).toBe(userA)
    expect(a.summary).toEqual({ calls: 3, inputTokens: 230, outputTokens: 125, totalTokens: 355 })
    expect(a.daily).toHaveLength(7)
    expect(a.models).toHaveLength(2)

    auth.requireAuth.mockResolvedValue({ userId: userB })
    const bResponse = await usageHandler(new NextRequest('http://localhost/api/me/usage?days=30&userId=' + userA))
    const b = await bResponse.json()
    expect(b.ownerId).toBe(userB)
    expect(bResponse.status).toBe(200)
    expect(b.summary).toEqual({ calls: 1, inputTokens: 999, outputTokens: 333, totalTokens: 1332 })
    expect(b.daily).toHaveLength(30)
  })

  it('writes real model and direct usage through Prisma/RLS, then reads it through the usage handler', async () => {
    const { modelChat } = await import('@/lib/model-router')
    const { recordAiUsage } = await import('@/lib/ai-usage')
    auth.pinnedFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: 'fixture response' } }],
      usage: { prompt_tokens: 12, completion_tokens: 34 },
    })))
    const result = await scope(userWriter, () => modelChat(
      [{ role: 'user', content: 'fixture prompt' }],
      { provider: 'minimax', model: 'MiniMax-M3', apiKey: 'fixture-only-key' },
      64,
      { userId: userWriter, featureKey: 'coverLetter', runtime: 'web', chargeBudget: false },
    ))
    expect(result).toMatchObject({ text: 'fixture response', inputTokens: 12, outputTokens: 34 })
    expect(auth.pinnedFetch).toHaveBeenCalledTimes(1)
    await scope(userWriter, () => recordAiUsage({
      userId: userWriter, featureKey: 'jobScoring', provider: 'minimax', model: 'MiniMax-M3',
      inputTokens: 6, outputTokens: 2, latencyMs: 1, status: 'success', runtime: 'web', chargeBudget: false,
    }))
    auth.requireAuth.mockResolvedValue({ userId: userWriter })
    const response = await usageHandler(new NextRequest('http://localhost/api/me/usage?days=7'))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.ownerId).toBe(userWriter)
    expect(body.summary).toEqual({ calls: 2, inputTokens: 18, outputTokens: 36, totalTokens: 54 })
    expect(body.models).toEqual([expect.objectContaining({ provider: 'minimax', model: 'MiniMax-M3', calls: 2 })])
  }, 20_000)

  it('writes real shared-worker usage with the tenant adapter and reads it through the handler', async () => {
    const { recordSharedAiUsage } = await import('../../../../../../packages/shared/src/ai-usage')
    const adapter = { query: (sql: string, values: unknown[] = []) => scope(userShared, () =>
      realDb!.$transaction(tx => tx.$executeRawUnsafe(sql, ...values))) }
    await recordSharedAiUsage(adapter, {
      userId: userShared, featureKey: 'autoApply', provider: 'minimax', model: 'MiniMax-M3',
      credentialSource: 'platform', runtime: 'worker', inputTokens: 8, outputTokens: 3, latencyMs: 2, status: 'success',
    })
    auth.requireAuth.mockResolvedValue({ userId: userShared })
    const response = await usageHandler(new NextRequest('http://localhost/api/me/usage?days=30'))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.ownerId).toBe(userShared)
    expect(body.summary).toEqual({ calls: 1, inputTokens: 8, outputTokens: 3, totalTokens: 11 })
  }, 20_000)
  it('returns exactly 12 original activity records with deterministic ties and no foreign or extra fields', async () => {
    auth.requireAuth.mockResolvedValue({ userId: userA })
    const response = await activityHandler(new NextRequest('http://localhost/api/me/activity?userId=' + userB + '&limit=50'))
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const body = await response.json() as { ownerId: string; items: Array<{ id: string; text: string; createdAt: string }> }
    expect(body.ownerId).toBe(userA)
    const rows = body.items
    expect(rows.map(row => row.id)).toEqual([...activityIds].reverse().slice(0, 12))
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['createdAt', 'id', 'text'])
      expect(row.text).toBe('same <original> text')
      expect(new Date(row.createdAt).toISOString()).toBe(row.createdAt)
    }
    expect(JSON.stringify(rows)).not.toContain('FOREIGN PRIVATE TEXT')
    auth.requireAuth.mockResolvedValue({ userId: userB })
    const foreignResponse = await activityHandler(new NextRequest('http://localhost/api/me/activity'))
    const foreignBody = await foreignResponse.json() as { ownerId: string; items: Array<{ id: string }> }
    expect(foreignBody.ownerId).toBe(userB)
    expect(foreignBody.items.map(row => row.id)).toEqual([foreignActivity])
  })

  it('applies real tenant RLS even when a query tries to select the other account', async () => {
    const rows = await scope(userA, () => realDb!.$transaction(tx =>
      tx.$queryRawUnsafe<Array<{ id: string }>>('SELECT id FROM ai_usage_events WHERE user_id = $1', userB),
    ))
    expect(rows).toEqual([])
    const activityRows = await scope(userA, () => realDb!.$transaction(tx =>
      tx.activity.findMany({ where: { userId: userB }, select: { id: true } }),
    ))
    expect(activityRows).toEqual([])
  })

  it('distinguishes an empty account, invalid input, and unauthorized responses', async () => {
    auth.requireAuth.mockResolvedValue({ userId: userEmpty })
    const emptyUsage = await usageHandler(new NextRequest('http://localhost/api/me/usage?days=7'))
    expect((await emptyUsage.json()).summary.calls).toBe(0)
    expect(await (await activityHandler(new NextRequest('http://localhost/api/me/activity'))).json()).toEqual({ ownerId: userEmpty, items: [] })
    const invalid = await usageHandler(new NextRequest('http://localhost/api/me/usage?days=8'))
    expect(invalid.status).toBe(400)
    expect(invalid.headers.get('Cache-Control')).toBe('no-store')
    auth.requireAuth.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    const unauthorizedUsage = await usageHandler(new NextRequest('http://localhost/api/me/usage'))
    const unauthorizedActivity = await activityHandler(new NextRequest('http://localhost/api/me/activity'))
    expect(unauthorizedUsage.status).toBe(401)
    expect(unauthorizedActivity.status).toBe(401)
    expect(unauthorizedUsage.headers.get('Cache-Control')).toBe('no-store')
    expect(unauthorizedActivity.headers.get('Cache-Control')).toBe('no-store')
  })

  it('returns a private 503 instead of an empty list when the real database rejects activity reads', async () => {
    auth.requireAuth.mockResolvedValue({ userId: userA })
    await admin!.$executeRawUnsafe('REVOKE SELECT ON "' + schema + '"."Activity" FROM "' + role + '"')
    try {
      const response = await activityHandler(new NextRequest('http://localhost/api/me/activity'))
      expect(response.status).toBe(503)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(await response.json()).toEqual({ error: 'Activity is temporarily unavailable' })
    } finally {
      await admin!.$executeRawUnsafe('GRANT SELECT ON "' + schema + '"."Activity" TO "' + role + '"')
    }
  })
  it('returns a private 503 instead of zero when the real database rejects usage reads', async () => {
    auth.requireAuth.mockResolvedValue({ userId: userA })
    await admin!.$executeRawUnsafe('REVOKE SELECT ON "' + schema + '".ai_usage_events FROM "' + role + '"')
    try {
      const response = await usageHandler(new NextRequest('http://localhost/api/me/usage?days=7'))
      expect(response.status).toBe(503)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(await response.json()).toEqual({ error: 'Usage data is temporarily unavailable' })
    } finally {
      await admin!.$executeRawUnsafe('GRANT SELECT ON "' + schema + '".ai_usage_events TO "' + role + '"')
    }
  })
})
