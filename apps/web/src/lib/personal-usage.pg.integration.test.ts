import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { readPersonalUsage } from './personal-usage'

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

describePg('personal usage with disposable PostgreSQL', () => {
  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } })
    await db.$connect()
    await db.$executeRawUnsafe('CREATE ROLE "' + role + '" NOLOGIN')
  })
  afterAll(async () => {
    if (!db) return
    await db.$executeRawUnsafe('DROP ROLE IF EXISTS "' + role + '"')
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

})
