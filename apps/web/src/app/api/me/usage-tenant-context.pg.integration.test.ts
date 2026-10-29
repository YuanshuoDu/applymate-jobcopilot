import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), userId: '', creditLimit: null as number | null }))
vi.mock('@/lib/safe-auth', () => ({ safeAuth: async () => ({ user: { id: mocks.userId } }) }))
vi.mock('@/lib/entitlements', () => ({
  isFeatureAllowed: async () => true,
  resolveAiAccess: async () => 'allowed',
  getEffectiveEntitlements: async () => ({ limits: { ai_credits: mocks.creditLimit } }),
}))
vi.mock('@/lib/admin/ai-config', () => ({ resolvePlatformRoute: async () => { throw new Error('unexpected platform route') } }))
vi.mock('@jobcopilot/shared/pinned-outbound', () => ({ pinnedFetch: mocks.fetch }))
vi.mock('@/lib/model-router', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/model-router')>(),
  loadUserAiConfig: async () => ({ provider: 'minimax', model: 'MiniMax-M3', resolvedKey: 'test-key', apiKey: 'test-key' }),
}))

function disposableUrl() {
  const value = process.env.PERSONAL_USAGE_PG_TEST_URL
  if (!value) {
    if (process.env.PERSONAL_USAGE_PG_TEST_REQUIRED === 'true') throw new Error('Disposable database required')
    return null
  }
  const url = new URL(value)
  if (process.env.PERSONAL_USAGE_PG_TEST_DISPOSABLE !== 'true' || url.protocol !== 'postgresql:' ||
      url.hostname !== '127.0.0.1' || url.port !== '56372' || url.username !== 'postgres' || url.password ||
      url.pathname !== '/personal_usage_disposable' || url.search || url.hash) throw new Error('Only disposable loopback database allowed')
  return value
}
const url = disposableUrl()
const pgDescribe = url ? describe : describe.skip
const suffix = randomUUID().replaceAll('-', '')
const schema = `usage_route_${suffix}`
const login = `usage_login_${suffix}`
const candidate = `usage_candidate_${suffix}`
const user = `usage_user_${suffix}`
const cache = globalThis as unknown as { prisma?: PrismaClient }
const previous = { prisma: cache.prisma, db: process.env.DATABASE_URL, mode: process.env.RLS_RUNTIME_MODE, role: process.env.RLS_CANDIDATE_ROLE }
let admin: PrismaClient
let appDb: PrismaClient
let handler: typeof import('../ai/cover-letter/route').POST

pgDescribe('cover letter auth and usage on disposable PostgreSQL', () => {
  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: url! } } })
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    await admin.$executeRawUnsafe(`CREATE ROLE "${candidate}" NOLOGIN`)
    await admin.$executeRawUnsafe(`CREATE ROLE "${login}" LOGIN PASSWORD 'fixture-only-password' NOSUPERUSER NOBYPASSRLS`)
    await admin.$executeRawUnsafe(`GRANT "${candidate}" TO "${login}"`)
    await admin.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${schema}" TO "${login}", "${candidate}"`)
    await admin.$executeRawUnsafe(`CREATE TABLE "${schema}"."User" (id text PRIMARY KEY, "accountStatus" text NOT NULL, "authVersion" integer NOT NULL)`)
    await admin.$executeRawUnsafe(`INSERT INTO "${schema}"."User" VALUES ($1, 'active', 1)`, user)
    await admin.$executeRawUnsafe(`GRANT SELECT ON "${schema}"."User" TO "${login}", "${candidate}"`)
    await admin.$executeRawUnsafe(`CREATE TYPE "${schema}"."AgentRoleType" AS ENUM ('scout', 'analyst', 'writer', 'reviewer', 'executor', 'auditor')`)
    await admin.$executeRawUnsafe(`CREATE TABLE "${schema}"."AgentRole" (id text PRIMARY KEY, "userId" text NOT NULL, role "${schema}"."AgentRoleType" NOT NULL, enabled boolean NOT NULL, provider text, model text, "apiKey" text, "systemPrompt" text)`)
    await admin.$executeRawUnsafe(`GRANT SELECT ON "${schema}"."AgentRole" TO "${login}", "${candidate}"`)
    await admin.$executeRawUnsafe(`CREATE TABLE "${schema}".ai_usage_events (
      id text PRIMARY KEY, user_id text, feature_key text NOT NULL, provider text NOT NULL, model text NOT NULL,
      input_tokens integer NOT NULL, output_tokens integer NOT NULL, estimated_cost_usd double precision NOT NULL,
      latency_ms integer NOT NULL, status text NOT NULL, error_code text, credential_source text NOT NULL,
      runtime text NOT NULL, created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      observed_role text, observed_user text
    )`)
    await admin.$executeRawUnsafe(`CREATE FUNCTION "${schema}".observe_usage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.observed_role := current_user; NEW.observed_user := current_setting('app.user_id', true); RETURN NEW; END $$`)
    await admin.$executeRawUnsafe(`CREATE TRIGGER observe_usage BEFORE INSERT ON "${schema}".ai_usage_events FOR EACH ROW EXECUTE FUNCTION "${schema}".observe_usage()`)
    await admin.$executeRawUnsafe(`ALTER TABLE "${schema}".ai_usage_events ENABLE ROW LEVEL SECURITY`)
    await admin.$executeRawUnsafe(`CREATE POLICY owner_isolation ON "${schema}".ai_usage_events USING (user_id = NULLIF(current_setting('app.user_id', true), '')) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''))`)
    await admin.$executeRawUnsafe(`GRANT SELECT, INSERT ON "${schema}".ai_usage_events TO "${candidate}", "${login}"`)
    await admin.$executeRawUnsafe(`CREATE TABLE "${schema}".ai_budgets (
      id text PRIMARY KEY, user_id text NOT NULL, month text NOT NULL, used integer NOT NULL DEFAULT 0,
      "limit" integer NOT NULL DEFAULT 30, version integer NOT NULL DEFAULT 1,
      created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamp(3) NOT NULL,
      UNIQUE (user_id, month)
    )`)
    await admin.$executeRawUnsafe(`ALTER TABLE "${schema}".ai_budgets ENABLE ROW LEVEL SECURITY`)
    await admin.$executeRawUnsafe(`CREATE POLICY budget_owner_isolation ON "${schema}".ai_budgets USING (user_id = NULLIF(current_setting('app.user_id', true), '')) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''))`)
    await admin.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE ON "${schema}".ai_budgets TO "${candidate}", "${login}"`)
    const appUrl = new URL(url!)
    appUrl.username = login
    appUrl.password = 'fixture-only-password'
    appUrl.searchParams.set('schema', schema)
    process.env.DATABASE_URL = appUrl.toString()
    process.env.RLS_RUNTIME_MODE = 'on'
    process.env.RLS_CANDIDATE_ROLE = candidate
    delete cache.prisma
    mocks.userId = user
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'Dear Hiring Manager, fixture.' } }], usage: { prompt_tokens: 12, completion_tokens: 34 } })))
    appDb = (await import('@/lib/db')).db
    handler = (await import('../ai/cover-letter/route')).POST
  }, 40_000)
  afterAll(async () => {
    await appDb?.$disconnect()
    if (admin) {
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${login}"`)
      await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${candidate}"`)
      await admin.$disconnect()
    }
    if (previous.prisma) cache.prisma = previous.prisma; else delete cache.prisma
    for (const [key, value] of Object.entries({ DATABASE_URL: previous.db, RLS_RUNTIME_MODE: previous.mode, RLS_CANDIDATE_ROLE: previous.role })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  }, 40_000)
  it('isolates concurrent usage writes for different users', async () => {
    const { recordAiUsage } = await import('@/lib/ai-usage')
    const users = [`concurrent_a_${suffix}`, `concurrent_b_${suffix}`]
    await Promise.all(users.map(userId => recordAiUsage({
      userId, provider: 'fixture', model: 'fixture', latencyMs: 1, status: 'success', chargeBudget: false,
    })))
    const rows = await admin.$queryRawUnsafe<Array<{user_id:string; observed_role:string; observed_user:string}>>(
      `SELECT user_id, observed_role, observed_user FROM "${schema}".ai_usage_events WHERE user_id IN ($1, $2) ORDER BY user_id`, ...users,
    )
    expect(rows).toEqual(users.map(userId => ({ user_id: userId, observed_role: candidate, observed_user: userId })))
  }, 40_000)

  it('charges the scoped budget once for success and failure, but not a no-charge attempt', async () => {
    const { recordAiUsage } = await import('@/lib/ai-usage')
    const budgetUser = `budget_${suffix}`
    mocks.creditLimit = 30
    try {
      await recordAiUsage({ userId: budgetUser, provider: 'fixture', model: 'm', latencyMs: 1, status: 'success' })
      await recordAiUsage({ userId: budgetUser, provider: 'fixture', model: 'm', latencyMs: 1, status: 'error' })
      await recordAiUsage({ userId: budgetUser, provider: 'fixture', model: 'm', latencyMs: 1, status: 'error', chargeBudget: false })
      const budgets = await admin.$queryRawUnsafe<Array<{user_id:string; used:number; limit:number}>>(
        `SELECT user_id, used, "limit" FROM "${schema}".ai_budgets WHERE user_id = $1`, budgetUser,
      )
      expect(budgets).toEqual([{ user_id: budgetUser, used: 2, limit: 30 }])
      const rows = await admin.$queryRawUnsafe<Array<{count:bigint}>>(`SELECT COUNT(*) AS count FROM "${schema}".ai_usage_events WHERE user_id = $1`, budgetUser)
      expect(Number(rows[0].count)).toBe(3)
    } finally { mocks.creditLimit = null }
  }, 40_000)

  it('records an administrative provider test without charging or including it in personal usage', async () => {
    const { recordAiUsage } = await import('@/lib/ai-usage')
    const { readPersonalUsage } = await import('@/lib/personal-usage')
    const { runWithTenantContext } = await import('@/lib/db/tenant-store')
    const adminUser = `admin_${suffix}`
    mocks.creditLimit = 30
    try {
      await recordAiUsage({ userId: adminUser, featureKey: 'providerTest', provider: 'fixture', model: 'catalog',
        runtime: 'admin', latencyMs: 1, status: 'success', chargeBudget: false })
      const rows = await admin.$queryRawUnsafe<Array<{user_id:string; feature_key:string; observed_role:string; observed_user:string}>>(
        `SELECT user_id, feature_key, observed_role, observed_user FROM "${schema}".ai_usage_events WHERE user_id = $1`, adminUser,
      )
      expect(rows).toEqual([{ user_id: adminUser, feature_key: 'providerTest', observed_role: candidate, observed_user: adminUser }])
      const budget = await admin.$queryRawUnsafe<Array<{count:bigint}>>(`SELECT count(*) AS count FROM "${schema}".ai_budgets WHERE user_id = $1`, adminUser)
      expect(Number(budget[0].count)).toBe(0)
      const usage = await runWithTenantContext(adminUser, () => appDb.$transaction(tx => readPersonalUsage(tx, adminUser, 30)))
      expect(usage.summary).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 })
      expect(usage.models).toEqual([])
    } finally { mocks.creditLimit = null }
  }, 40_000)

  it('records a real authenticated route request under the candidate identity and user scope', async () => {
    const { runWithTenantContext, currentTenantUserId } = await import('@/lib/db/tenant-store')
    expect(currentTenantUserId()).toBeNull()
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const first = runWithTenantContext('scope_probe_a', async () => {
      await barrier
      return currentTenantUserId()
    })
    const second = runWithTenantContext('scope_probe_b', async () => {
      await Promise.resolve()
      const actual = currentTenantUserId()
      release()
      return actual
    })
    expect(await Promise.all([first, second])).toEqual(['scope_probe_a', 'scope_probe_b'])
    expect(currentTenantUserId()).toBeNull()
    const request = new NextRequest('http://localhost/api/ai/cover-letter', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resumeContent: {}, jobTitle: 'Engineer', jobCompany: 'Fixture' }) })
    const response = await handler(request)
    if (!response) throw new Error('Cover-letter route returned no response')
    expect(response.status).toBe(200)
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    const rows = await admin.$queryRawUnsafe<Array<{user_id:string; observed_role:string; observed_user:string; input_tokens:number; output_tokens:number}>>(`SELECT user_id, observed_role, observed_user, input_tokens, output_tokens FROM "${schema}".ai_usage_events WHERE user_id = $1`, user)
    expect(rows).toEqual([{ user_id: user, observed_role: candidate, observed_user: user, input_tokens: 12, output_tokens: 34 }])
  }, 40_000)
})
