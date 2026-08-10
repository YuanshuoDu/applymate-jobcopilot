import { Prisma } from '@prisma/client'
import Redis from 'ioredis'
import { db } from '../db'
import { sendWorkerCommand } from './worker-client'
import { EXPECTED_MIGRATIONS, RLS_TABLES } from './deployment-readiness-manifest'

export type ReadinessState = 'ready' | 'missing' | 'unavailable'

type MigrationRow = {
  migration_name: string
  finished_at: Date | null
  rolled_back_at: Date | null
}

export type WorkerProbe = { state: ReadinessState; workerState: 'running' | 'paused' | null }
export type RlsProbe = { state: ReadinessState; runtimeConfigured: boolean; candidateRole: string; missingTables: string[] }
export type AuditProbe = { state: ReadinessState; hashTrigger: boolean; checkpointTable: boolean; secretConfigured: boolean }

export function hasValue(value: string | undefined) {
  return Boolean(value?.trim())
}

export async function migrationReadiness() {
  if (!hasValue(process.env.DATABASE_URL)) return { state: 'missing' as const, missing: [], pending: [], rolledBack: [] }
  try {
    const rows = await db.$queryRaw<MigrationRow[]>`
      SELECT migration_name, finished_at, rolled_back_at
      FROM "_prisma_migrations"
      WHERE migration_name IN (${Prisma.join(EXPECTED_MIGRATIONS.map(name => Prisma.sql`${name}`))})
    `
    const applied = new Set(rows
      .filter(row => row.finished_at !== null && row.rolled_back_at === null)
      .map(row => row.migration_name))
    const missing = EXPECTED_MIGRATIONS.filter(migration => !applied.has(migration))
    const pending = rows.filter(row => row.finished_at === null && row.rolled_back_at === null).map(row => row.migration_name)
    const rolledBack = rows.filter(row => row.rolled_back_at !== null).map(row => row.migration_name)
    return {
      state: missing.length === 0 && pending.length === 0 && rolledBack.length === 0 ? 'ready' as const : 'missing' as const,
      missing: [...missing], pending, rolledBack,
    }
  } catch {
    return { state: 'unavailable' as const, missing: [], pending: [], rolledBack: [] }
  }
}

export async function databaseProbe(): Promise<ReadinessState> {
  if (!hasValue(process.env.DATABASE_URL)) return 'missing'
  try {
    await db.$queryRaw`SELECT 1`
    return 'ready'
  } catch {
    return 'unavailable'
  }
}

export async function redisProbe(): Promise<ReadinessState> {
  const url = process.env.REDIS_URL?.trim()
  if (!url) return 'missing'
  let client: Redis | null = null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') return 'missing'
    client = new Redis(url, { connectTimeout: 2_000, maxRetriesPerRequest: 1, retryStrategy: () => null })
    await client.ping()
    return 'ready'
  } catch {
    return 'unavailable'
  } finally {
    client?.disconnect()
  }
}

export async function workerProbe(): Promise<WorkerProbe> {
  if (!hasValue(process.env.WORKER_CONTROL_URL) || !hasValue(process.env.WORKER_CONTROL_SECRET)) {
    return { state: 'missing', workerState: null }
  }
  try {
    const result = await sendWorkerCommand({
      requestId: `readiness-${Date.now()}`,
      actorId: 'deployment-readiness',
      action: 'queue_summary',
      reason: 'Check production worker readiness',
      params: {},
    }, { timeoutMs: 2_500 })
    return { state: 'ready', workerState: result.worker?.state ?? null }
  } catch {
    return { state: 'unavailable', workerState: null }
  }
}

export async function rlsProbe(): Promise<RlsProbe> {
  const candidateRole = process.env.RLS_CANDIDATE_ROLE?.trim() ?? ''
  const runtimeConfigured = process.env.RLS_RUNTIME_MODE === 'on' && hasValue(candidateRole)
  if (!runtimeConfigured) return { state: 'missing', runtimeConfigured: false, candidateRole, missingTables: [...RLS_TABLES] }
  if (!hasValue(process.env.DATABASE_URL)) return { state: 'missing', runtimeConfigured: true, candidateRole, missingTables: [] }

  try {
    const expected = Prisma.join(RLS_TABLES.map(name => Prisma.sql`(${name})`))
    const rows = await db.$queryRaw<Array<{ name: string; enabled: boolean; role_exists: boolean; role_bypass_rls: boolean }>>`
      WITH expected(name) AS (VALUES ${expected})
      SELECT expected.name,
             COALESCE(c.relrowsecurity, false) AS enabled,
             (r.rolname IS NOT NULL) AS role_exists,
             COALESCE(r.rolbypassrls, false) AS role_bypass_rls
      FROM expected
      LEFT JOIN pg_class c ON c.relname = expected.name
        AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
      LEFT JOIN pg_roles r ON r.rolname = ${candidateRole}
    `
    const missingTables = rows.filter(row => !row.enabled).map(row => row.name)
    const roleReady = rows.length === RLS_TABLES.length && rows.every(row => row.role_exists && !row.role_bypass_rls)
    return { state: roleReady && missingTables.length === 0 ? 'ready' : 'missing', runtimeConfigured: true, candidateRole, missingTables }
  } catch {
    return { state: 'unavailable', runtimeConfigured: true, candidateRole, missingTables: [] }
  }
}

export async function auditProbe(): Promise<AuditProbe> {
  const secretConfigured = hasValue(process.env.AUDIT_CHECKPOINT_CRON_SECRET) || hasValue(process.env.WEB_MAINTENANCE_CRON_SECRET)
  if (!hasValue(process.env.DATABASE_URL)) return { state: 'missing', hashTrigger: false, checkpointTable: false, secretConfigured }
  try {
    const rows = await db.$queryRaw<Array<{ hash_trigger: boolean; checkpoint_table: boolean }>>`
      SELECT
        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'admin_audit_hash_chain') AS hash_trigger,
        EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'admin_audit_checkpoints') AS checkpoint_table
    `
    const hashTrigger = rows[0]?.hash_trigger === true
    const checkpointTable = rows[0]?.checkpoint_table === true
    return { state: secretConfigured && hashTrigger && checkpointTable ? 'ready' : 'missing', hashTrigger, checkpointTable, secretConfigured }
  } catch {
    return { state: 'unavailable', hashTrigger: false, checkpointTable: false, secretConfigured }
  }
}
