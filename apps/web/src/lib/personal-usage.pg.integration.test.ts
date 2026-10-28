import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { readPersonalUsage } from './personal-usage'

vi.mock('@/lib/entitlements', () => ({ getEffectiveEntitlements: vi.fn(async () => ({ limits: { ai_credits: null } })) }))
import { admitAiUsage, settleAiUsage, type UsageAdmissionInput, type UsageBrokerDatabase, type UsageBrokerQuery } from './agent/control-plane/usage-broker'

function disposableUrl(): string | null {
  const value = process.env.PERSONAL_USAGE_PG_TEST_URL
  if (!value) {
    if (process.env.PERSONAL_USAGE_PG_TEST_REQUIRED === 'true') throw new Error('A disposable PostgreSQL instance is required')
    return null
  }
  const url = new URL(value)
  if (process.env.PERSONAL_USAGE_PG_TEST_DISPOSABLE !== 'true' ||
    url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' ||
    url.username !== 'postgres' || url.pathname !== '/personal_usage_disposable' ||
    url.search || url.hash) throw new Error('Only the designated loopback disposable database is allowed')
  return value
}

const databaseUrl = disposableUrl()
const describePg = databaseUrl ? describe : describe.skip
const role = 'usage_reader_' + randomUUID().replaceAll('-', '')
let db: PrismaClient
let candidateCreated = false

describePg('personal usage with disposable PostgreSQL', () => {
  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } })
    await db.$connect()
    await db.$executeRawUnsafe('CREATE ROLE "' + role + '" NOLOGIN')
    const candidate = await db.$queryRawUnsafe<Array<{ exists: boolean }>>("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'applymate_candidate') AS exists")
    if (!candidate[0].exists) { await db.$executeRawUnsafe('CREATE ROLE applymate_candidate NOLOGIN'); candidateCreated = true }
  })
  afterAll(async () => {
    if (!db) return
    await db.$executeRawUnsafe('DROP ROLE IF EXISTS "' + role + '"')
    if (candidateCreated) await db.$executeRawUnsafe('DROP ROLE applymate_candidate')
    await db.$disconnect()
  })

  it('reconciles 7/30 UTC day buckets, owner filtering, RLS and excluded records in a non-UTC session', async () => {
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Asia/Tokyo'")
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE ai_usage_events (
        id text primary key, user_id text, feature_key text not null, provider text not null, model text not null,
        runtime text not null, status text not null, input_tokens integer not null, output_tokens integer not null,
        created_at timestamp(3) not null
      ) ON COMMIT DROP`)
      await tx.$executeRawUnsafe(`INSERT INTO ai_usage_events VALUES
        ('start', 'owner-a', 'coverLetter', 'openai', 'shared', 'web', 'success', 100, 20, '2026-10-22 00:00:00'),
        ('inside', 'owner-a', 'autoApply', 'other', 'shared', 'worker', 'error', 50, 5, '2026-10-28 11:59:59'),
        ('before', 'owner-a', 'embedding', 'openai', 'embed', 'web', 'success', 3, 0, '2026-10-21 23:59:59'),
        ('end', 'owner-a', 'coverLetter', 'openai', 'shared', 'web', 'success', 9, 9, '2026-10-28 12:00:00'),
        ('other-user', 'owner-b', 'coverLetter', 'openai', 'shared', 'web', 'success', 999, 999, '2026-10-24 00:00:00'),
        ('reserved', 'owner-a', 'autoApply', 'other', 'shared', 'worker', 'reserved', 99, 99, '2026-10-24 00:00:00'),
        ('released', 'owner-a', 'autoApply', 'other', 'shared', 'worker', 'released', 99, 99, '2026-10-24 00:00:00'),
        ('admin', 'owner-a', 'providerTest', 'openai', 'models-catalog', 'admin', 'success', 0, 0, '2026-10-24 00:00:00'),
        ('admin-model', 'owner-a', 'agent', 'openai', 'admin-model', 'admin', 'success', 7, 3, '2026-10-24 00:00:00'),
        ('legacy-probe', 'owner-a', 'providerTest', 'openai', 'models-catalog', 'unknown', 'error', 0, 0, '2026-10-24 00:00:00')
      `)
      await tx.$executeRawUnsafe('ALTER TABLE ai_usage_events ENABLE ROW LEVEL SECURITY')
      await tx.$executeRawUnsafe("CREATE POLICY usage_owner ON ai_usage_events USING (user_id = current_setting('app.user_id', true))")
      await tx.$executeRawUnsafe('GRANT SELECT ON ai_usage_events TO "' + role + '"')
      await tx.$executeRawUnsafe('SET LOCAL ROLE "' + role + '"')
      await tx.$executeRawUnsafe("SELECT set_config('app.user_id', 'owner-a', true)")
      const now = new Date('2026-10-28T12:00:00.000Z')
      const week = await readPersonalUsage(tx, 'owner-a', 7, now)
      expect(week.summary).toEqual({ calls: 3, inputTokens: 157, outputTokens: 28, totalTokens: 185 })
      expect(week.daily).toHaveLength(7)
      expect(week.daily[0]).toMatchObject({ date: '2026-10-22', calls: 1, totalTokens: 120 })
      expect(week.daily[6]).toMatchObject({ date: '2026-10-28', calls: 1, totalTokens: 55 })
      expect(week.models).toHaveLength(3)
      expect((await readPersonalUsage(tx, 'owner-b', 7, now)).summary.calls).toBe(0)
      const month = await readPersonalUsage(tx, 'owner-a', 30, now)
      expect(month.summary).toEqual({ calls: 4, inputTokens: 160, outputTokens: 28, totalTokens: 188 })
    }, { timeout: 30_000 })
  })
  it('applies the actual tenant migration without exposing or modifying another owner', async () => {
    const migration = readFileSync(join(process.cwd(), 'prisma/migrations/20261028220000_secure_personal_ai_usage/migration.sql'), 'utf8')
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE ai_usage_events (
        id text primary key, user_id text, feature_key text not null, provider text not null, model text not null,
        runtime text not null, status text not null, input_tokens integer not null, output_tokens integer not null,
        created_at timestamp(3) not null
      ) ON COMMIT DROP`)
      await tx.$executeRawUnsafe('ALTER TABLE ai_usage_events ADD COLUMN estimated_cost_usd double precision NOT NULL DEFAULT 0, ADD COLUMN error_code text')
      await tx.$executeRawUnsafe(migration)
      await tx.$executeRawUnsafe(`INSERT INTO ai_usage_events VALUES
        ('a','owner-a','agent','x','m','web','success',1,2,CURRENT_TIMESTAMP),
        ('b','owner-b','agent','x','m','worker','success',3,4,CURRENT_TIMESTAMP),
        ('system',NULL,'agent','x','m','admin','success',0,0,CURRENT_TIMESTAMP)`)
      // Owner bypass remains available to trusted workers and admin operations.
      expect((await tx.$queryRawUnsafe<Array<{count: bigint}>>('SELECT count(*) AS count FROM ai_usage_events'))[0].count).toBe(BigInt(3))
      await tx.$executeRawUnsafe('SET LOCAL ROLE applymate_candidate')
      expect((await tx.$queryRawUnsafe<Array<{count: bigint}>>('SELECT count(*) AS count FROM ai_usage_events'))[0].count).toBe(BigInt(0))
      await tx.$executeRawUnsafe("SELECT set_config('app.user_id','owner-a',true)")
      expect((await tx.$queryRawUnsafe<Array<{id: string}>>('SELECT id FROM ai_usage_events')).map(row => row.id)).toEqual(['a'])
      await tx.$executeRawUnsafe("INSERT INTO ai_usage_events VALUES ('a2','owner-a','agent','x','m','web','success',1,2,CURRENT_TIMESTAMP)")
      expect(await tx.$executeRawUnsafe("UPDATE ai_usage_events SET status='error' WHERE id='a2'")).toBe(1)
      expect(await tx.$executeRawUnsafe("UPDATE ai_usage_events SET status='error' WHERE id='b'")).toBe(0)
      for (const sql of [
        "INSERT INTO ai_usage_events VALUES ('b2','owner-b','agent','x','m','web','success',0,0,CURRENT_TIMESTAMP)",
        "INSERT INTO ai_usage_events VALUES ('null2',NULL,'agent','x','m','web','success',0,0,CURRENT_TIMESTAMP)",
        "UPDATE ai_usage_events SET user_id='owner-b' WHERE id='a2'",
        "DELETE FROM ai_usage_events WHERE id='a2'",
      ]) {
        await tx.$executeRawUnsafe('SAVEPOINT rejected')
        await expect(tx.$executeRawUnsafe(sql)).rejects.toThrow()
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT rejected')
      }
      await tx.$executeRawUnsafe('RESET ROLE')
      expect((await tx.$queryRawUnsafe<Array<{status:string}>>("SELECT status FROM ai_usage_events WHERE id='b'"))[0].status).toBe('success')
    }, { timeout: 30_000 })
  }, 40_000)

  it('uses UTC for future default and explicit writer timestamps in a non-UTC database session', async () => {
    const migration = readFileSync(join(process.cwd(), 'prisma/migrations/20261028143000_ai_usage_created_at_utc/migration.sql'), 'utf8')
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Asia/Tokyo'")
      await tx.$executeRawUnsafe('CREATE TEMP TABLE ai_usage_events (source text, user_id text, created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP) ON COMMIT DROP')
      for (const statement of migration.split(';').map(part => part.trim()).filter(Boolean)) await tx.$executeRawUnsafe(statement)
      await tx.$executeRawUnsafe("INSERT INTO ai_usage_events (source) VALUES ('default')")
      await tx.$executeRawUnsafe("INSERT INTO ai_usage_events (source, created_at) VALUES ('broker-admit', CURRENT_TIMESTAMP AT TIME ZONE 'UTC'), ('broker-release', CURRENT_TIMESTAMP AT TIME ZONE 'UTC'), ('shared-writer', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')")
      const rows = await tx.$queryRawUnsafe<Array<{ source: string; offset: number }>>("SELECT source, ABS(EXTRACT(EPOCH FROM (created_at - (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))))::float8 AS offset FROM ai_usage_events ORDER BY source")
      expect(rows.map(row => row.source)).toEqual(['broker-admit', 'broker-release', 'default', 'shared-writer'])
      for (const row of rows) expect(row.offset).toBeLessThan(0.01)
    })
  })

  it('runs real broker admit, settlement and both release paths in a non-UTC PostgreSQL session', async () => {
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Asia/Tokyo'")
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE ai_usage_events (
        id text primary key, user_id text, feature_key text not null, provider text not null, model text not null,
        credential_source text not null, runtime text not null, status text not null, error_code text,
        input_tokens integer not null, output_tokens integer not null, estimated_cost_usd double precision not null,
        latency_ms integer not null, created_at timestamp(3) not null
      ) ON COMMIT DROP`)
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE agent_turns (
        id text primary key, "sessionId" text not null, "userId" text not null, status text not null,
        "leaseOwnerId" text not null, "leaseVersion" integer not null, "leaseExpiresAt" timestamptz not null
      ) ON COMMIT DROP`)
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE agent_steps (
        id text primary key, "turnId" text not null, "sessionId" text not null, "taskId" text,
        attempt integer not null, status text not null
      ) ON COMMIT DROP`)
      // SQL planning requires the root-task table even though this root step has taskId NULL.
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE sub_agent_tasks (
        id text primary key, "sessionId" text, "turnId" text, "rootTaskId" text, status text,
        "interruptRequestedAt" timestamptz, "attemptCount" integer
      ) ON COMMIT DROP`)
      await tx.$executeRawUnsafe(`INSERT INTO agent_turns VALUES
        ('turn-1', 'session-1', 'broker-owner', 'in_progress', 'worker-1', 4, CURRENT_TIMESTAMP + INTERVAL '1 hour')`)
      await tx.$executeRawUnsafe(`INSERT INTO agent_steps VALUES
        ('step-1', 'turn-1', 'session-1', NULL, 1, 'streaming')`)

      const migration = readFileSync(join(process.cwd(), 'prisma/migrations/20261028220000_secure_personal_ai_usage/migration.sql'), 'utf8')
      await tx.$executeRawUnsafe(migration)
      await tx.$executeRawUnsafe('GRANT SELECT, UPDATE ON agent_turns, agent_steps, sub_agent_tasks TO applymate_candidate')
      await tx.$executeRawUnsafe('SET LOCAL ROLE applymate_candidate')
      // Execute broker SQL on the real transaction; this adapter does not claim independent/concurrent transactions.
      const broker: UsageBrokerDatabase = { $transaction: async <T,>(work: (query: UsageBrokerQuery) => Promise<T>) => work(tx) }
      const input: UsageAdmissionInput = {
        userId: 'broker-owner', sessionId: 'session-1', turnId: 'turn-1', stepId: 'step-1',
        leaseOwnerId: 'worker-1', leaseVersion: 4, featureKey: 'agent', provider: 'minimax', model: 'MiniMax-M3',
        attemptId: 'completed', credentialSource: 'platform',
      }
      const completed = await admitAiUsage(broker, input)
      await settleAiUsage(broker, { operationId: completed.operationId, userId: input.userId,
        provider: input.provider, model: input.model, status: 'success', inputTokens: 10, outputTokens: 4, estimatedCostUsd: 0 })
      const released = { ...input, attemptId: 'released' }
      await admitAiUsage(broker, released)
      await settleAiUsage(broker, { ...released, status: 'released' })
      await settleAiUsage(broker, { ...input, attemptId: 'tombstone', status: 'released' })
      await expect(admitAiUsage(broker, { ...input, attemptId: 'bad-fence', leaseOwnerId: 'other-worker' }))
        .rejects.toMatchObject({ code: 'usage_fence_rejected' })

      const rows = await tx.$queryRawUnsafe<Array<{ status: string; delta: number }>>(`
        SELECT status, ABS(EXTRACT(EPOCH FROM (created_at - (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))))::float8 AS delta
        FROM ai_usage_events ORDER BY status, id`)
      expect(rows.map(row => row.status)).toEqual(['released', 'released', 'success'])
      for (const row of rows) expect(row.delta).toBeLessThan(0.01)
      const result = await readPersonalUsage(tx, input.userId, 7)
      expect(result.summary).toEqual({ calls: 1, inputTokens: 10, outputTokens: 4, totalTokens: 14 })
      expect(result.models).toEqual([expect.objectContaining({ provider: input.provider, model: input.model, calls: 1 })])
    }, { timeout: 30_000 })
  }, 40_000)

})
