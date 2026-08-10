import type { Pool } from 'pg'
import {
  evaluateManagedFeature,
  platformEnvironment,
  type ManagedFeatureKey,
  type PlatformEnvironment,
} from '@jobcopilot/shared/feature-flags'

type FeatureFlagRow = {
  enabled: boolean
  rolloutPercent: number
  targetPlans: string[]
  targetUserIds: string[]
  status: string
  rollbackAt: Date | null
}

export async function isWorkerFeatureEnabled(
  pool: Pick<Pool, 'query'>,
  key: ManagedFeatureKey,
  userId: string,
  environment: PlatformEnvironment = platformEnvironment(process.env),
): Promise<boolean> {
  try {
    const [userResult, flagResult] = await Promise.all([
      pool.query<{ plan: string }>('SELECT plan::text AS plan FROM "User" WHERE id = $1', [userId]),
      pool.query<FeatureFlagRow>(`
        SELECT enabled, "rolloutPercent", "targetPlans", "targetUserIds", status::text AS status, "rollbackAt"
        FROM "PlatformFeatureFlag"
        WHERE key = $1 AND environment = $2
      `, [key, environment]),
    ])
    return evaluateManagedFeature(key, {
      environment,
      userId,
      plan: userResult.rows[0]?.plan ?? null,
      flag: flagResult.rows[0] ?? null,
    })
  } catch (error) {
    if (isMissingFeatureFlagTable(error)) {
      return evaluateManagedFeature(key, { environment, userId, plan: null, flag: null })
    }
    throw new Error(`Platform feature flag lookup failed for ${key}`, { cause: error })
  }
}

function isMissingFeatureFlagTable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '42P01'
}
