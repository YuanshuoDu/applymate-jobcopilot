import { db } from '../db'
import type { PlatformIntegrationStatus } from './integration-status'
import {
  auditProbe,
  databaseProbe,
  hasValue,
  migrationReadiness,
  redisProbe,
  rlsProbe,
  workerProbe,
  type AuditProbe,
  type ReadinessState,
  type RlsProbe,
  type WorkerProbe,
} from './deployment-readiness-probes'
import { EXPECTED_MIGRATIONS } from './deployment-readiness-manifest'

export { EXPECTED_MIGRATIONS }
export type { ReadinessState }

export type DeploymentReadiness = {
  candidateSettings: {
    migrations: { state: ReadinessState; missing: string[]; pending?: string[]; rolledBack?: string[] }
    superAdminPermission: ReadinessState
    currentActorPermission: 'ready' | 'missing'
  }
  infrastructure?: { database: ReadinessState; redis: ReadinessState }
  workerControl: {
    state: ReadinessState
    reachability?: ReadinessState
    urlConfigured: boolean
    secretConfigured: boolean
    redisConfigured: boolean
    workerState?: 'running' | 'paused' | null
  }
  security?: {
    webauthn: { state: ReadinessState; originConfigured: boolean; rpIdConfigured: boolean; adminAppUrlConfigured: boolean }
    rls: RlsProbe
    audit: AuditProbe
  }
}

type ReadinessActor = { permissions: readonly string[] }

export type DeploymentReadinessProbes = {
  database?: () => Promise<ReadinessState>
  redis?: () => Promise<ReadinessState>
  worker?: () => Promise<WorkerProbe>
  rls?: () => Promise<RlsProbe>
  audit?: () => Promise<AuditProbe>
}

async function superAdminPermissionReadiness(): Promise<ReadinessState> {
  if (!hasValue(process.env.DATABASE_URL)) return 'missing'
  try {
    const role = await db.adminRole.findUnique({ where: { key: 'super_admin' }, select: { permissions: true } })
    return role?.permissions.includes('users.update_preferences') ? 'ready' : 'missing'
  } catch {
    return 'unavailable'
  }
}

export async function getDeploymentReadiness(
  actor: ReadinessActor,
  integrations: PlatformIntegrationStatus,
  overrides: DeploymentReadinessProbes = {},
): Promise<DeploymentReadiness> {
  const { infrastructure } = integrations
  const [migrations, superAdminPermission, database, redis, worker, rls, audit] = await Promise.all([
    migrationReadiness(),
    superAdminPermissionReadiness(),
    overrides.database?.() ?? databaseProbe(),
    overrides.redis?.() ?? redisProbe(),
    infrastructure.workerControlUrl && infrastructure.workerControlSecret
      ? (overrides.worker?.() ?? workerProbe())
      : Promise.resolve<WorkerProbe>({ state: 'missing', workerState: null }),
    overrides.rls?.() ?? rlsProbe(),
    overrides.audit?.() ?? auditProbe(),
  ])
  const webauthn = {
    originConfigured: hasValue(process.env.WEBAUTHN_ORIGIN),
    rpIdConfigured: hasValue(process.env.WEBAUTHN_RP_ID),
    adminAppUrlConfigured: hasValue(process.env.ADMIN_APP_URL),
  }

  return {
    candidateSettings: {
      migrations,
      superAdminPermission,
      currentActorPermission: actor.permissions.includes('users.update_preferences') ? 'ready' : 'missing',
    },
    infrastructure: { database, redis },
    workerControl: {
      state: worker.state,
      reachability: worker.state,
      urlConfigured: infrastructure.workerControlUrl,
      secretConfigured: infrastructure.workerControlSecret,
      redisConfigured: infrastructure.redis,
      workerState: worker.workerState,
    },
    security: {
      webauthn: { state: Object.values(webauthn).every(Boolean) ? 'ready' : 'missing', ...webauthn },
      rls,
      audit,
    },
  }
}
