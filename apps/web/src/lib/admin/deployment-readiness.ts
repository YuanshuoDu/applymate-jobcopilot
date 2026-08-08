import { db } from '@/lib/db'
import type { PlatformIntegrationStatus } from './integration-status'

const REQUIRED_MIGRATIONS = [
  '20260603170000_add_ai_budget',
  '20260807110000_add_user_preferences_admin_permission',
] as const

type ReadinessState = 'ready' | 'missing' | 'unavailable'

type MigrationRow = {
  migration_name: string
  finished_at: Date | null
  rolled_back_at: Date | null
}

export type DeploymentReadiness = {
  candidateSettings: {
    migrations: { state: ReadinessState; missing: string[] }
    superAdminPermission: ReadinessState
    currentActorPermission: 'ready' | 'missing'
  }
  workerControl: {
    state: 'ready' | 'missing'
    urlConfigured: boolean
    secretConfigured: boolean
    redisConfigured: boolean
  }
}

type ReadinessActor = { permissions: readonly string[] }

async function migrationReadiness(): Promise<DeploymentReadiness['candidateSettings']['migrations']> {
  try {
    const rows = await db.$queryRaw<MigrationRow[]>`
      SELECT migration_name, finished_at, rolled_back_at
      FROM "_prisma_migrations"
      WHERE migration_name IN (
        '20260603170000_add_ai_budget',
        '20260807110000_add_user_preferences_admin_permission'
      )
    `
    const applied = new Set(rows
      .filter(row => row.finished_at !== null && row.rolled_back_at === null)
      .map(row => row.migration_name))
    const missing = REQUIRED_MIGRATIONS.filter(migration => !applied.has(migration))
    return { state: missing.length === 0 ? 'ready' : 'missing', missing: [...missing] }
  } catch {
    return { state: 'unavailable', missing: [] }
  }
}

async function superAdminPermissionReadiness(): Promise<ReadinessState> {
  try {
    const role = await db.adminRole.findUnique({
      where: { key: 'super_admin' },
      select: { permissions: true },
    })
    return role?.permissions.includes('users.update_preferences') ? 'ready' : 'missing'
  } catch {
    return 'unavailable'
  }
}

export async function getDeploymentReadiness(
  actor: ReadinessActor,
  integrations: PlatformIntegrationStatus,
): Promise<DeploymentReadiness> {
  const [migrations, superAdminPermission] = await Promise.all([
    migrationReadiness(),
    superAdminPermissionReadiness(),
  ])
  const { infrastructure } = integrations
  const workerReady = infrastructure.workerControlUrl && infrastructure.workerControlSecret

  return {
    candidateSettings: {
      migrations,
      superAdminPermission,
      currentActorPermission: actor.permissions.includes('users.update_preferences') ? 'ready' : 'missing',
    },
    workerControl: {
      state: workerReady ? 'ready' : 'missing',
      urlConfigured: infrastructure.workerControlUrl,
      secretConfigured: infrastructure.workerControlSecret,
      redisConfigured: infrastructure.redis,
    },
  }
}
